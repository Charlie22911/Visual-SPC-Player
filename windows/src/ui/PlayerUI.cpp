#include "PlayerUI.h"
#include "audio/AudioEngine.h"
#include "model/Library.h"
#include "model/Settings.h"
#include "model/PresentationState.h"
#include "platform/Files.h"
#include "render/MapRenderer.h"
#include "render/WaterfallRenderer.h"
#include "imgui.h"
#include <shlwapi.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <deque>
#include <map>
#include <optional>
#include <set>
#include <sstream>
namespace visual_spc {
namespace {
double now100ns() {
    LARGE_INTEGER ticks{}, frequency{}; QueryPerformanceCounter(&ticks); QueryPerformanceFrequency(&frequency);
    return static_cast<double>(ticks.QuadPart) * 10000000.0 / static_cast<double>(frequency.QuadPart);
}
uint16_t u16(const uint8_t* data) { return static_cast<uint16_t>(data[0] | data[1] << 8); }
struct Item { std::filesystem::path path, relative; std::string label; };
struct Row { std::filesystem::path path; std::string label; bool folder; };
struct PlotClip {
    ImDrawList* draw;
    bool active = true;
    void end() {
        if (!active) return;
        draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerLinear, nullptr);
        draw->PopClipRect(); active = false;
    }
    ~PlotClip() { end(); }
};
}
struct PlayerUI::Impl {
    HWND window;
    D3DDevice* graphics;
    Library library;
    AudioEngine audio;
    Settings settings;
    History history;
    Metrics metrics;
    std::unique_ptr<MapRenderer> mapRenderer;
    std::unique_ptr<WaterfallRenderer> waterfallRenderer;
    std::filesystem::path storage, root, folder;
    std::vector<Item> items;
    std::set<std::filesystem::path> knownPaths;
    std::vector<Row> browserRows;
    std::array<char, 256> search{};
    bool browserDirty = true, scanning = false, appliedPlaying = false;
    bool mapDirty = true, smoke = false;
    unsigned displayNumerator = 60, displayDenominator = 1, appliedRateNumerator = 0, appliedRateDenominator = 0;
    float appliedVolume = -1;
    uint64_t lastMapId = 0, received = 0, presented = 0, rejected = 0;
    uint32_t nextGeneration = 1, mapGeneration = 0;
    ScanSelection scanSelection;
    PreparedLoadState prepared;
    PlaybackIntent intent;
    std::map<uint32_t, LoadResult> tracks;
    std::deque<spc_native_instance*> retirePending;
    MapActivityUnion mapAccess;
    std::vector<float> mapEntropy;
    std::array<uint8_t, 65536> heldKinds{}, visibleKinds{};
    std::array<uint64_t, 65536> seenAt{};
    std::array<uint8_t, 65536> lastDiagnosticRam{};
    bool diagnosticBaseline = false;
    uint64_t changedStates = 0, changedBytes = 0, changedEchoBytes = 0, lastNative = 0;
    std::deque<nlohmann::json> diagnosticPoints;
    ClockAnchor anchor{};
    double mediaFrame = 0, fpsAt = now100ns(), actualFps = 0, renderMilliseconds = 0;
    unsigned frameCounter = 0;
    int panel = 0;
    std::string status;
    bool mapFit = true;
    float mapScale = 1, mapCenterX = 0.5f, mapCenterY = 0.5f;
    uint32_t waterfallStart = 0, waterfallSpan = 65536, lastColumns = 0, lastPlotWidth = 0;
    bool waterfallFit = true;
    Impl(HWND hwnd, D3DDevice& device) : window(hwnd), graphics(&device) {
        resetGraphics(device);
        try {
            storage = dataDirectory();
            if (std::filesystem::exists(storage / L"settings.json")) settings = parseSettings(readText(storage / L"settings.json"));
            if (std::filesystem::exists(storage / L"library.json")) {
                const auto saved = nlohmann::json::parse(readText(storage / L"library.json", 8 * 1024 * 1024));
                if (saved.value("format", "") == "visual-spc-player-library") {
                    if (saved.contains("root") && saved["root"].is_string()) openFolder(wide(saved["root"].get<std::string>()));
                    else if (saved.contains("files")) {
                        std::vector<std::filesystem::path> paths;
                        for (const auto& path : saved["files"]) paths.emplace_back(wide(path.get<std::string>()));
                        addFiles(paths);
                    }
                }
            }
        } catch (const std::exception& error) { status = error.what(); }
    }
    ~Impl() {
        if (auto* pending = prepared.releasePending()) library.retire(pending);
        for (auto* instance : retirePending) library.retire(instance);
    }
    void resetGraphics(D3DDevice& device) {
        graphics = &device;
        mapRenderer = std::make_unique<MapRenderer>(device.device.Get(), device.context.Get());
        waterfallRenderer = std::make_unique<WaterfallRenderer>(device.device.Get(), device.context.Get());
        mapDirty = true;
    }
    void addFiles(const std::vector<std::filesystem::path>& paths) {
        const auto oldSize = items.size();
        for (const auto& path : paths) {
            if (!knownPaths.insert(path).second) continue;
            auto relative = root.empty() ? path.filename() : path.lexically_relative(root);
            items.push_back({path, relative, utf8(path.filename().wstring())});
        }
        if (items.size() == oldSize) return;
        const auto less = [](const Item& a, const Item& b) {
            return StrCmpLogicalW(a.relative.c_str(), b.relative.c_str()) < 0;
        };
        std::sort(items.begin() + oldSize, items.end(), less);
        std::inplace_merge(items.begin(), items.begin() + oldSize, items.end(), less);
        browserDirty = true;
    }
    void openFolder(const std::filesystem::path& path) {
        root = path; folder.clear(); items.clear(); knownPaths.clear(); browserDirty = true;
        scanSelection.begin(library.scan(path)); scanning = true;
    }
    void open(const std::vector<std::filesystem::path>& paths) {
        if (paths.empty()) return;
        std::error_code error;
        if (paths.size() == 1 && std::filesystem::is_directory(paths.front(), error)) { openFolder(paths.front()); return; }
        library.cancelScan(); scanning = false; scanSelection.invalidate();
        root.clear(); folder.clear(); items.clear(); knownPaths.clear(); addFiles(paths); load(paths.front(), true);
    }
    void load(const std::filesystem::path& path, bool autoplay) {
        const auto request = library.load(path);
        if (request) {
            if (auto* stale = prepared.begin(request)) retirePending.push_back(stale);
            intent.request(request, autoplay);
            status = "Loading " + utf8(path.filename().wstring());
        }
        else status = "The file worker is busy; try opening the file again.";
    }
    void saveSettings() {
        if (!smoke && !storage.empty() && !library.save(storage / L"settings.json", serializeSettings(settings)))
            status = "The file worker is busy; settings have not been saved.";
        mapDirty = true;
    }
    void saveLibrary() {
        nlohmann::json document{{"format", "visual-spc-player-library"}, {"version", 1}};
        if (!root.empty()) document["root"] = utf8(root.wstring());
        else {
            document["files"] = nlohmann::json::array();
            for (const auto& item : items) document["files"].push_back(utf8(item.path.wstring()));
        }
        if (!library.save(storage / L"library.json", document.dump(2))) status = "The file worker is busy.";
        else status = "Library locations saved.";
    }
    void diagnose(const Capture& capture) {
        if (!settings.diagnostic) { diagnosticBaseline = false; return; }
        uint64_t changed = 0, echoChanged = 0;
        if (diagnosticBaseline) {
            const unsigned echoStart = capture.state[32 + 0x6d] << 8, echoLength = (capture.state[32 + 0x7d] & 15) * 2048;
            for (unsigned a = 0; a < 65536; ++a) if (capture.ram[a] != lastDiagnosticRam[a]) {
                ++changed;
                if (((a + 65536 - echoStart) & 65535) < echoLength) ++echoChanged;
            }
        }
        lastDiagnosticRam = capture.ram; diagnosticBaseline = true;
        changedBytes += changed; changedEchoBytes += echoChanged; if (changed) ++changedStates;
        diagnosticPoints.push_back({{"generation", capture.generation}, {"sequence", capture.sequence},
            {"nativeFrame", capture.nativeFrame}, {"spacingFrames", capture.nativeFrame >= lastNative ? capture.nativeFrame - lastNative : 0},
            {"changedBytes", changed}, {"changedEchoBytes", echoChanged}, {"discontinuity", capture.discontinuity}});
        if (diagnosticPoints.size() > 2048) diagnosticPoints.pop_front();
        lastNative = capture.nativeFrame;
    }
    void tick() {
        ScanBatch batch;
        std::vector<std::filesystem::path> additions;
        while (library.popScan(batch)) if (scanSelection.accepts(batch.revision)) {
            additions.insert(additions.end(), batch.files.begin(), batch.files.end()); if (batch.complete) scanning = false;
            if (!batch.error.empty()) status = batch.error;
        }
        addFiles(additions);
        LoadResult loaded;
        while (library.popLoad(loaded)) {
            if (loaded.id != prepared.latest()) { if (loaded.instance) retirePending.push_back(loaded.instance); continue; }
            if (!loaded.error.empty()) { intent.complete(loaded.id, false); status = loaded.error; continue; }
            if (auto* stale = prepared.receive(std::move(loaded))) retirePending.push_back(stale);
        }
        while (!retirePending.empty() && library.retire(retirePending.front())) retirePending.pop_front();
        spc_native_instance* retired = nullptr;
        while (retirePending.size() < 64 && audio.popRetired(retired)) {
            if (!library.retire(retired)) retirePending.push_back(retired);
        }
        if (auto accepted = prepared.commit([&](auto* instance) { return audio.replace(instance, nextGeneration); })) {
            intent.complete(accepted->id, true);
            tracks[nextGeneration++] = std::move(*accepted); status.clear();
        }
        if (appliedPlaying != intent.playing() && audio.setPlaying(intent.playing())) appliedPlaying = intent.playing();
        if (appliedVolume != settings.volume && audio.setVolume(settings.volume)) appliedVolume = settings.volume;
        const unsigned numerator = settings.rate ? static_cast<unsigned>(settings.rate) : displayNumerator;
        const unsigned denominator = settings.rate ? 1 : displayDenominator;
        if ((numerator != appliedRateNumerator || denominator != appliedRateDenominator) &&
            audio.setCaptureRate(numerator, denominator)) { appliedRateNumerator = numerator; appliedRateDenominator = denominator; }
        while (const auto* capture = audio.captures().consumer_slot()) {
            ++received; diagnose(*capture);
            try { if (!history.accept(*capture)) ++rejected; }
            catch (const std::bad_alloc&) { ++rejected; status = "History memory is full; retained time is shorter."; }
            audio.captures().consume();
        }
        ClockAnchor fresh;
        while (audio.popAnchor(fresh)) anchor = fresh;
        if (anchor.rate) {
            const auto elapsed = std::max(0.0, now100ns() - static_cast<double>(anchor.qpc100ns)) * anchor.rate / 10000000.0;
            mediaFrame = anchor.mediaFrame + std::min(elapsed, anchor.remainingDeviceFrames) * anchor.sourceStep;
            if (history.present(anchor.generation, mediaFrame)) { ++presented; mapDirty = true; updateMapAccess(); }
        }
        if (settings.persistence && history.selected()) {
            for (unsigned a = 0; a < 65536; ++a)
                visibleKinds[a] = mediaFrame - static_cast<double>(seenAt[a]) <= settings.persistenceMilliseconds * 32 ? heldKinds[a] : 0;
            mapDirty = true;
        }
        while (library.popWarning(status)) {}
    }
    void updateMapAccess() {
        const auto* selected = history.selected(); if (!selected) return;
        if (selected->generation != mapGeneration) {
            lastMapId = 0; mapGeneration = selected->generation; heldKinds.fill(0); seenAt.fill(0); visibleKinds.fill(0); mapAccess.reset();
            for (auto i = tracks.begin(); i != tracks.end() && i->first < mapGeneration;) i = tracks.erase(i);
        }
        if (panel != 0 || settings.waterfall) mapAccess.drawn();
        const auto& records = history.records();
        auto first = std::upper_bound(records.begin(), records.end(), lastMapId,
            [](uint64_t id, const auto& record) { return id < record->id; });
        for (auto i = first; i != records.end() && (*i)->id <= selected->id; ++i) {
            const auto& record = **i;
            if (!record.continuous) { heldKinds.fill(0); seenAt.fill(0); }
            mapAccess.add(record.access);
            for (unsigned a = 0; a < 65536; ++a) {
                const unsigned mask = 1u << (a & 7), index = a >> 3;
                const auto kind = (record.access[index] & mask ? 1 : 0) | (record.access[8192 + index] & mask ? 2 : 0) |
                    (record.access[16384 + index] & mask ? 4 : 0);
                if (kind) { heldKinds[a] = static_cast<uint8_t>(kind); seenAt[a] = record.nativeFrame; }
            }
        }
        lastMapId = selected->id;
    }
    const LoadResult* track() const {
        const auto* selected = history.selected(); if (!selected) return nullptr;
        const auto found = tracks.find(selected->generation); return found == tracks.end() ? nullptr : &found->second;
    }
    void rebuildBrowser() {
        browserRows.clear(); std::set<std::filesystem::path> directories;
        const auto needle = wide(search.data());
        for (const auto& item : items) {
            if (!needle.empty()) {
                if (StrStrIW(item.relative.c_str(), needle.c_str())) browserRows.push_back({item.path, item.label, false});
                continue;
            }
            if (item.relative.parent_path() == folder) browserRows.push_back({item.path, item.label, false});
            else if (!root.empty()) {
                const auto remaining = item.relative.lexically_relative(folder.empty() ? std::filesystem::path(L".") : folder);
                if (remaining.empty() || *remaining.begin() == L"..") continue;
                if (remaining.has_parent_path()) directories.insert(folder / *remaining.begin());
            }
        }
        std::vector<Row> folders;
        for (const auto& directory : directories) folders.push_back({directory, utf8(directory.filename().wstring()) + "/", true});
        browserRows.insert(browserRows.begin(), folders.begin(), folders.end()); browserDirty = false;
    }
    void libraryPanel() {
        ImGui::TextUnformatted("Library"); ImGui::TextDisabled("%zu SPC files%s", items.size(), scanning ? " · scanning" : "");
        if (ImGui::Button("Open folder")) { const auto paths = chooseFiles(window, true); if (!paths.empty()) openFolder(paths.front()); }
        ImGui::SameLine();
        if (ImGui::Button("Open files")) open(chooseFiles(window));
        if (ImGui::Button("Save library")) saveLibrary();
        if (scanning) { ImGui::SameLine(); if (ImGui::Button("Cancel")) { library.cancelScan(); scanSelection.invalidate(); scanning = false; } }
        if (ImGui::InputTextWithHint("##search", "Search folders and tracks", search.data(), search.size())) browserDirty = true;
        if (!folder.empty() && ImGui::Button("< Up")) { folder = folder.parent_path(); browserDirty = true; }
        if (!root.empty()) ImGui::TextWrapped("%s", utf8((root / folder).wstring()).c_str());
        ImGui::Separator();
        if (browserDirty) rebuildBrowser();
        ImGuiListClipper clipper; clipper.Begin(static_cast<int>(browserRows.size()), ImGui::GetTextLineHeightWithSpacing() + 8);
        const auto* current = track();
        while (clipper.Step()) for (int index = clipper.DisplayStart; index < clipper.DisplayEnd; ++index) {
            const auto& row = browserRows[index]; ImGui::PushID(index);
            if (ImGui::Selectable(row.label.c_str(), current && current->path == row.path, 0, ImVec2(0, ImGui::GetTextLineHeight() + 8))) {
                if (row.folder) { folder = row.path; browserDirty = true; }
                else load(row.path, true);
            }
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", utf8(row.path.wstring()).c_str());
            ImGui::PopID();
        }
    }
    void transport() {
        const auto* current = track();
        ImGui::TextColored(ImVec4(0.55f, 1, 0.88f, 1), "Visual SPC Player");
        ImGui::SameLine(220 * ImGui::GetStyle().FontScaleDpi);
        const auto title = current ? (current->metadata.title[0] ? std::string(current->metadata.title) : utf8(current->path.stem().wstring())) : "Open an SPC file to begin";
        ImGui::TextUnformatted(title.c_str());
        ImGui::SameLine(); ImGui::TextDisabled("%s", current ? current->metadata.game : "");
        const auto seconds = static_cast<unsigned>(std::max(0.0, mediaFrame) / 32000);
        ImGui::Text("%02u:%02u", seconds / 60, seconds % 60); ImGui::SameLine();
        if (ImGui::Button(intent.playing() ? "Pause" : "Play")) intent.setPlaying(!intent.playing());
        ImGui::SameLine();
        if (ImGui::Button("Restart") && current) load(current->path, false);
        ImGui::SameLine(); ImGui::SetNextItemWidth(180 * ImGui::GetStyle().FontScaleDpi);
        if (ImGui::SliderFloat("Volume", &settings.volume, 0, 1, "%.2f")) saveSettings();
        if (!status.empty()) { ImGui::SameLine(); ImGui::TextDisabled("%s", status.c_str()); }
        ImGui::Separator();
    }
    void zoomWaterfall(double factor, double anchorFraction = 0.5) {
        const double address = waterfallStart + waterfallSpan * anchorFraction;
        waterfallSpan = static_cast<uint32_t>(std::clamp(std::round(waterfallSpan * factor), 1.0, 65536.0));
        waterfallStart = static_cast<uint32_t>(std::clamp(std::round(address - waterfallSpan * anchorFraction), 0.0, 65536.0 - waterfallSpan));
        waterfallFit = false;
    }
    void memoryPanel() {
        bool changed = false;
        if (ImGui::RadioButton("Map", !settings.waterfall)) { settings.waterfall = false; changed = true; }
        ImGui::SameLine();
        if (ImGui::RadioButton("Waterfall", settings.waterfall)) { settings.waterfall = true; changed = true; }
        ImGui::SameLine(); ImGui::SetNextItemWidth(120 * ImGui::GetStyle().FontScaleDpi);
        changed |= ImGui::Combo("##measurement", &settings.mode, "Activity\0Data\0Entropy\0");
        ImGui::SameLine(); bool& bits = settings.selectedBits();
        if (ImGui::RadioButton("Byte", !bits)) { bits = false; changed = true; }
        ImGui::SameLine(); if (ImGui::RadioButton("Bit", bits)) { bits = true; changed = true; }
        if (ImGui::Button("-")) { if (settings.waterfall) zoomWaterfall(2); else { mapScale = clampMapScale(mapScale * 0.5f); mapFit = false; } }
        ImGui::SameLine();
        if (ImGui::Button("Fit")) { if (settings.waterfall) { waterfallStart = 0; waterfallSpan = 65536; waterfallFit = true; } else mapFit = true; }
        ImGui::SameLine();
        if (ImGui::Button("1:1")) { if (settings.waterfall) { waterfallSpan = std::max(1u, lastColumns); waterfallStart = std::min(waterfallStart, 65536 - waterfallSpan); waterfallFit = false; } else { mapScale = 1; mapFit = false; } }
        ImGui::SameLine();
        if (ImGui::Button("+")) { if (settings.waterfall) zoomWaterfall(0.5); else { mapScale = clampMapScale(mapScale * 2); mapFit = false; } }
        ImGui::SameLine();
        if (settings.waterfall) {
            ImGui::SetNextItemWidth(65 * ImGui::GetStyle().FontScaleDpi); int duration = settings.seconds == 2 ? 0 : settings.seconds == 5 ? 1 : 2;
            if (ImGui::Combo("##duration", &duration, "2 s\0" "5 s\0" "10 s\0")) { settings.seconds = duration == 0 ? 2 : duration == 1 ? 5 : 10; changed = true; }
        }
        if (settings.mode == 1) { ImGui::SameLine(); changed |= ImGui::Checkbox("XOR", &settings.xorData); }
        if (settings.mode == 0) { ImGui::SameLine(); changed |= ImGui::Checkbox("Show data underneath", &settings.underlay); }
        if (changed) saveSettings();
        const auto available = ImGui::GetContentRegionAvail();
        const ImVec2 plotSize(std::max(1.0f, available.x), std::max(120.0f, available.y - ImGui::GetTextLineHeightWithSpacing() * 2));
        const auto origin = ImGui::GetCursorScreenPos();
        ImGui::InvisibleButton("##plot", plotSize, ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonMiddle);
        const bool hovered = ImGui::IsItemHovered(), active = ImGui::IsItemActive();
        const auto* selected = history.selected();
        auto* draw = ImGui::GetWindowDrawList();
        draw->AddRectFilled(origin, ImVec2(origin.x + plotSize.x, origin.y + plotSize.y), IM_COL32(2, 5, 12, 255));
        if (!selected) { draw->AddText(ImVec2(origin.x + 20, origin.y + 20), IM_COL32(140, 165, 185, 255), "Open an SPC file to view ARAM."); return; }
        ViewConfig view{static_cast<Measurement>(settings.mode), settings.bits(), settings.mode == 1 && settings.xorData,
            settings.mode == 0 && settings.underlay, 0, 65536, 256};
        draw->PushClipRect(origin, ImVec2(origin.x + plotSize.x, origin.y + plotSize.y), true);
        PlotClip clipping{draw};
        draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerNearest, nullptr);
        std::string inspection;
        if (!settings.waterfall) {
            const unsigned width = view.bits ? 1024 : 256, height = view.bits ? 512 : 256;
            const float dpi = ImGui::GetStyle().FontScaleDpi;
            if (mapFit) { mapScale = std::min(plotSize.x / (width * dpi), plotSize.y / (height * dpi)); mapCenterX = mapCenterY = 0.5f; }
            const auto mouse = ImGui::GetIO().MousePos;
            if (hovered && ImGui::GetIO().MouseWheel != 0) {
                const auto old = mapScale;
                mapScale = clampMapScale(mapScale * std::pow(1.5f, ImGui::GetIO().MouseWheel));
                mapCenterX += (mouse.x - origin.x - plotSize.x / 2) / width * (1 / old - 1 / mapScale) / dpi;
                mapCenterY += (mouse.y - origin.y - plotSize.y / 2) / height * (1 / old - 1 / mapScale) / dpi; mapFit = false;
            }
            if (active && (ImGui::IsMouseDragging(0) || ImGui::IsMouseDragging(2))) {
                mapCenterX -= ImGui::GetIO().MouseDelta.x / (width * mapScale * dpi);
                mapCenterY -= ImGui::GetIO().MouseDelta.y / (height * mapScale * dpi); mapFit = false;
            }
            mapCenterX = std::clamp(mapCenterX, 0.0f, 1.0f); mapCenterY = std::clamp(mapCenterY, 0.0f, 1.0f);
            if (mapDirty) {
                mapEntropy = view.measurement == Measurement::Entropy ? metrics.entropy(selected->ram, view.bits) : std::vector<float>{};
                mapRenderer->upload(*selected, history.previous(*selected), mapAccess.bytes(), visibleKinds, mapEntropy); mapDirty = false;
            }
            mapRenderer->draw(view, settings.palette, settings.persistence);
            mapAccess.drawn();
            const float cell = physicalMapScale(mapScale, dpi);
            const ImVec2 top(origin.x + plotSize.x / 2 - mapCenterX * width * cell,
                origin.y + plotSize.y / 2 - mapCenterY * height * cell);
            draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(mapRenderer->texture())), top,
                ImVec2(top.x + width * cell, top.y + height * cell));
            const auto x = static_cast<int>((mouse.x - top.x) / cell), y = static_cast<int>((mouse.y - top.y) / cell);
            if (hovered && mouse.x >= top.x && mouse.y >= top.y && x >= 0 && y >= 0 && x < static_cast<int>(width) && y < static_cast<int>(height)) {
                const unsigned address = view.bits ? (y >> 1) * 256 + (x >> 2) : y * 256 + x;
                char buffer[160];
                std::snprintf(buffer, sizeof(buffer), "$%04X · byte $%02X (%u)%s", address, selected->ram[address], selected->ram[address], view.bits ? " · bits 7…0, 4×2 tile" : "");
                if (view.measurement == Measurement::Entropy) {
                    const unsigned lane = view.bits ? (y & 1) * 4 + (x & 3) : 0;
                    std::snprintf(buffer, sizeof(buffer), "$%04X–$%04X · entropy %.5f %s", address & ~255u, address | 255u,
                        mapEntropy[lane * 256 + (address >> 8)], view.bits ? "bits / bit position" : "bits / byte");
                } else if (view.changesOnly) {
                    const auto* previous = history.previous(*selected);
                    if (previous) std::snprintf(buffer, sizeof(buffer), "$%04X · byte $%02X · XOR mask $%02X",
                        address, selected->ram[address], selected->ram[address] ^ previous->ram[address]);
                    else std::snprintf(buffer, sizeof(buffer), "$%04X · XOR baseline unavailable", address);
                }
                inspection = buffer;
                draw->AddRect(ImVec2(top.x + x * cell, top.y + y * cell),
                    ImVec2(top.x + (x + 1) * cell, top.y + (y + 1) * cell), IM_COL32(255, 255, 255, 220));
            }
        } else {
            const unsigned lanes = view.bits ? 8 : 1;
            const float dpi = ImGui::GetStyle().FontScaleDpi;
            const ImVec2 graphOrigin(origin.x + 46 * dpi, origin.y + 22 * dpi);
            const ImVec2 graphSize(std::max(1.0f, plotSize.x - 46 * dpi), std::max(1.0f, plotSize.y - 22 * dpi));
            const auto mouse = ImGui::GetIO().MousePos;
            const bool graphHovered = hovered && mouse.x >= graphOrigin.x && mouse.y >= graphOrigin.y;
            const auto sampling = plotSampling(graphSize.x, graphSize.y, dpi, view.bits, 65536);
            auto columns = sampling.columns;
            const auto logicalWidth = static_cast<unsigned>(std::max(1.0f, std::floor(graphSize.x / dpi)));
            const auto center = waterfallStart + waterfallSpan / 2.0;
            if (!waterfallFit && lastColumns && logicalWidth != lastPlotWidth) {
                waterfallSpan = std::clamp(static_cast<uint32_t>(std::round(static_cast<double>(waterfallSpan) * columns / lastColumns)), 1u, 65536u);
                waterfallStart = static_cast<uint32_t>(std::clamp(std::round(center - waterfallSpan / 2.0), 0.0, 65536.0 - waterfallSpan));
            }
            lastPlotWidth = logicalWidth;
            if (waterfallFit) { waterfallStart = 0; waterfallSpan = 65536; }
            waterfallStart = std::min(waterfallStart, 65536 - waterfallSpan);
            if (graphHovered && ImGui::GetIO().MouseWheel != 0) zoomWaterfall(std::pow(2.0, -ImGui::GetIO().MouseWheel), std::clamp((mouse.x - graphOrigin.x) / graphSize.x, 0.0f, 1.0f));
            if (active && graphHovered && (ImGui::IsMouseDragging(0) || ImGui::IsMouseDragging(2))) {
                waterfallStart = static_cast<uint32_t>(std::clamp<double>(std::round(waterfallStart -
                    ImGui::GetIO().MouseDelta.x * waterfallSpan / graphSize.x), 0.0, 65536.0 - waterfallSpan)); waterfallFit = false;
            }
            columns = std::min(columns, waterfallSpan); lastColumns = columns;
            view.start = waterfallStart; view.span = waterfallSpan; view.columns = columns;
            waterfallRenderer->configure(view, sampling.rows, settings.seconds);
            waterfallRenderer->update(history, std::min(4.0, 500.0 / targetRate()));
            waterfallRenderer->draw(settings.palette);
            draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(waterfallRenderer->texture())), graphOrigin, ImVec2(graphOrigin.x + graphSize.x, graphOrigin.y + graphSize.y));
            for (int tick = 0; tick <= 4; ++tick) {
                const auto y = graphOrigin.y + tick * graphSize.y / 4;
                char label[40]; std::snprintf(label, sizeof(label), "-%.1fs", settings.seconds * tick / 4.0);
                draw->AddText(ImVec2(origin.x + 4 * dpi, std::min(y, origin.y + plotSize.y - ImGui::GetTextLineHeight())), IM_COL32(205, 225, 240, 210), label);
            }
            for (unsigned tick = 0; tick < 3; ++tick) {
                char label[16]; const auto address = waterfallStart + static_cast<uint32_t>((waterfallSpan - 1ull) * tick / 2);
                std::snprintf(label, sizeof(label), "$%04X", address);
                const auto size = ImGui::CalcTextSize(label);
                draw->AddText(ImVec2(graphOrigin.x + (graphSize.x - size.x) * tick / 2, origin.y), IM_COL32(185, 210, 230, 255), label);
            }
            if (graphHovered) {
                draw->AddLine(ImVec2(mouse.x, graphOrigin.y), ImVec2(mouse.x, graphOrigin.y + graphSize.y), IM_COL32(220, 240, 255, 100));
                draw->AddLine(ImVec2(graphOrigin.x, mouse.y), ImVec2(graphOrigin.x + graphSize.x, mouse.y), IM_COL32(220, 240, 255, 100));
                const auto pixel = std::min(columns * lanes - 1, static_cast<unsigned>((mouse.x - graphOrigin.x) / graphSize.x * columns * lanes));
                const unsigned column = pixel / lanes, lane = pixel % lanes;
                const auto band = waterfallRenderer->newestBand() - static_cast<int64_t>(plotRowAt(mouse.y - graphOrigin.y, graphSize.y, sampling.rows));
                const auto& row = waterfallRenderer->inspect(history, band);
                const auto range = bucketRange(view.start, view.span, columns, column);
                char buffer[180];
                if (row.valid) std::snprintf(buffer, sizeof(buffer), "$%04X–$%04X · %.5g%s · %.4f–%.4f s ago", range.first, range.second - 1,
                    row.values[lane * columns + column], view.bits ? " (bit lane)" : "", (selected->nativeFrame - (band + 1) * waterfallRenderer->framesPerBand()) / 32000,
                    (selected->nativeFrame - band * waterfallRenderer->framesPerBand()) / 32000);
                else std::snprintf(buffer, sizeof(buffer), "$%04X–$%04X · unavailable history", range.first, range.second - 1);
                inspection = buffer;
            }
        }
        clipping.end();
        ImGui::TextDisabled("%s", inspection.empty() ? "Scroll to zoom · drag to pan · hover to inspect" : inspection.c_str());
        if (settings.mode == 0) ImGui::TextDisabled("Read (blue) · Write (green) · Execute (amber) · overlaps blend");
        else ImGui::TextDisabled(settings.mode == 2 ? (settings.entropyBits ? "Entropy: 0–1 bits per bit position · 256-byte blocks" : "Entropy: 0–8 bits per byte · 256-byte blocks") : "Data describes the selected captured state");
    }
    double targetRate() const noexcept { return settings.rate ? settings.rate : static_cast<double>(displayNumerator) / displayDenominator; }
    void voicePanel() {
        const auto* snapshot = history.selected(); if (!snapshot) { ImGui::TextUnformatted("Open an SPC file."); return; }
        if (ImGui::BeginTable("Voices", 13, ImGuiTableFlags_Borders | ImGuiTableFlags_ScrollX | ImGuiTableFlags_RowBg)) {
            for (const char* name : {"Voice", "L", "R", "Pitch", "BRR", "Source", "Envelope", "ADSR", "Gain", "ENVX", "OUTX", "Mode", "KON/KOFF/ENDX"}) ImGui::TableSetupColumn(name);
            ImGui::TableHeadersRow();
            for (unsigned voice = 0; voice < 8; ++voice) {
                const auto* v = snapshot->state.data() + 160 + voice * 16;
                ImGui::TableNextRow(); ImGui::TableNextColumn(); ImGui::Text("%u", voice + 1);
                ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[0]));
                ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[1]));
                ImGui::TableNextColumn(); ImGui::Text("$%04X", u16(v + 2));
                ImGui::TableNextColumn(); ImGui::Text("$%04X", u16(v + 6));
                ImGui::TableNextColumn(); ImGui::Text("$%02X", v[8]);
                ImGui::TableNextColumn(); ImGui::ProgressBar(u16(v + 4) / 2047.0f, ImVec2(100 * ImGui::GetStyle().FontScaleDpi, 0));
                ImGui::TableNextColumn(); ImGui::Text("$%02X %02X", v[9], v[10]);
                ImGui::TableNextColumn(); ImGui::Text("$%02X", v[11]);
                ImGui::TableNextColumn(); ImGui::Text("%u", v[12]);
                ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[13]));
                ImGui::TableNextColumn(); ImGui::Text("%s", v[14] < 4 ? std::array{"Release", "Attack", "Decay", "Sustain"}[v[14]] : "?");
                ImGui::TableNextColumn(); ImGui::Text("%u / %u / %u", v[15] & 1, (v[15] >> 1) & 1, (v[15] >> 2) & 1);
            }
            ImGui::EndTable();
        }
    }
    void dspPanel() {
        const auto* snapshot = history.selected(); if (!snapshot) return;
        const auto* dsp = snapshot->state.data() + 32;
        ImGui::Text("DIR $%02X00 · ESA $%02X00 · EDL %u · FLG $%02X", dsp[0x5d], dsp[0x6d], dsp[0x7d] & 15, dsp[0x6c]);
        if (ImGui::BeginTable("DSP registers", 17, ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg)) {
            ImGui::TableSetupColumn("Address"); for (unsigned x = 0; x < 16; ++x) { char label[8]; std::snprintf(label, sizeof(label), "%X", x); ImGui::TableSetupColumn(label); }
            ImGui::TableHeadersRow();
            for (unsigned row = 0; row < 8; ++row) {
                ImGui::TableNextRow(); ImGui::TableNextColumn(); ImGui::Text("$%02X", row * 16);
                for (unsigned column = 0; column < 16; ++column) { ImGui::TableNextColumn(); ImGui::Text("%02X", dsp[row * 16 + column]); }
            }
            ImGui::EndTable();
        }
    }
    void trackPanel() {
        const auto* current = track(); if (!current) return;
        ImGui::TextWrapped("%s", utf8(current->path.wstring()).c_str());
        for (const auto& pair : {std::pair{"Title", current->metadata.title}, {"Game", current->metadata.game},
            {"Artist", current->metadata.artist}, {"Dumper", current->metadata.dumper}, {"Comments", current->metadata.comments}})
            ImGui::TextWrapped("%s: %s", pair.first, pair.second);
        ImGui::Text("ID666: %s · duration %u s · fade %u ms (informational)",
            current->metadata.has_id666 ? (current->metadata.binary_id666 ? "binary" : "text") : "absent",
            current->metadata.song_seconds, current->metadata.fade_milliseconds);
    }
    void settingsPanel() {
        bool changed = false;
        int rateIndex = settings.rate == 30 ? 0 : settings.rate == 60 ? 1 : 2;
        ImGui::SetNextItemWidth(180 * ImGui::GetStyle().FontScaleDpi);
        if (ImGui::Combo("Refresh rate", &rateIndex, "30 Hz\0" "60 Hz\0" "Display\0")) { settings.rate = rateIndex == 0 ? 30 : rateIndex == 1 ? 60 : 0; changed = true; }
        ImGui::SetNextItemWidth(180 * ImGui::GetStyle().FontScaleDpi);
        changed |= ImGui::Combo("Palette", &settings.palette, "Spectrum\0Scope\0Original\0Grayscale\0Accessible\0");
        changed |= ImGui::Checkbox("Activity persistence", &settings.persistence);
        ImGui::SetNextItemWidth(220 * ImGui::GetStyle().FontScaleDpi); changed |= ImGui::SliderInt("Persistence (ms)", &settings.persistenceMilliseconds, 10, 2000);
        changed |= ImGui::Checkbox("Byte-refresh diagnostic", &settings.diagnostic);
        if (changed) saveSettings();
        if (ImGui::Button("Import settings")) {
            const auto paths = chooseFiles(window);
            if (!paths.empty()) { settings = parseSettings(readText(paths.front())); saveSettings(); }
        }
        ImGui::SameLine();
        if (ImGui::Button("Export settings")) { const auto path = chooseSave(window, L"Visual-SPC-Player-settings.json"); if (!path.empty()) library.save(path, serializeSettings(settings)); }
        ImGui::Separator();
        ImGui::Text("Visual SPC Player %s · x64 / SSE2 baseline", SPC_PLAYER_VERSION);
#ifdef NDEBUG
        ImGui::TextUnformatted(SPC_HAS_IPO ? "Release: /O2 + IPO" : "Release: /O2");
#else
        ImGui::TextUnformatted("Debug build");
#endif
        ImGui::TextWrapped("Native C++20 · WASAPI shared audio · Direct3D 11 · GPU: %s%s", utf8(graphics->adapterName).c_str(), graphics->software ? " (software WARP)" : "");
        ImGui::Text("Audio endpoint: %u Hz · HRESULT $%08lX · history %.1f MiB", audio.sampleRate(), audio.lastError(), history.payloadBytes() / 1048576.0);
        if (anchor.rate) ImGui::Text("Endpoint: %u channels · %u-bit %s · period %u frames (%.3f ms) · buffer %u frames",
            anchor.channels, anchor.bits, anchor.floating ? "float" : "PCM", anchor.periodFrames,
            anchor.periodFrames * 1000.0 / anchor.rate, anchor.bufferFrames);
        ImGui::Text("Display: %.3f Hz · rendering %.3f ms", static_cast<double>(displayNumerator) / displayDenominator, renderMilliseconds);
        if (settings.diagnostic) {
            ImGui::Separator();
            ImGui::Text("Received %llu · presented %llu · changed %llu", received, presented, changedStates);
            ImGui::Text("Changed bytes %llu · echo %llu · capture drops %u · history rejects %llu", changedBytes, changedEchoBytes, anchor.drops, rejected);
            ImGui::Text("Native frame %llu · audible frame %.3f · captured/presented rates follow the selected cadence", lastNative, mediaFrame);
            if (ImGui::Button("Export diagnostic")) {
                const auto path = chooseSave(window, L"Visual-SPC-Player-diagnostic.json");
                if (!path.empty()) {
                    nlohmann::json points = nlohmann::json::array(); for (const auto& point : diagnosticPoints) points.push_back(point);
                    library.save(path, nlohmann::json{{"format", "visual-spc-player-byte-refresh"}, {"version", 1},
                        {"received", received}, {"presented", presented}, {"changedStates", changedStates}, {"samples", points}}.dump(2));
                }
            }
        }
    }
    void draw() {
        const auto start = now100ns();
        auto* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->WorkPos); ImGui::SetNextWindowSize(viewport->WorkSize);
        ImGui::Begin("Visual SPC Player", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings);
        transport();
        ImGui::BeginChild("Library", ImVec2(260 * ImGui::GetStyle().FontScaleDpi, 0), ImGuiChildFlags_Borders);
        try { libraryPanel(); } catch (const std::exception& error) { status = error.what(); }
        ImGui::EndChild(); ImGui::SameLine();
        ImGui::BeginChild("Player", ImVec2(0, 0));
        for (int i = 0; i < 5; ++i) {
            if (i) ImGui::SameLine();
            if (ImGui::Selectable(std::array{"ARAM", "Voices", "DSP", "Track", "Settings"}[i], panel == i, 0, ImVec2(70 * ImGui::GetStyle().FontScaleDpi, 0))) panel = i;
        }
        ImGui::Separator();
        ImGui::BeginChild("Panel content", ImVec2(0, -ImGui::GetTextLineHeightWithSpacing() * 2));
        try {
            if (panel == 0) memoryPanel(); else if (panel == 1) voicePanel();
            else if (panel == 2) dspPanel(); else if (panel == 3) trackPanel(); else settingsPanel();
        } catch (const std::exception& error) { status = error.what(); }
        ImGui::EndChild(); ImGui::Separator();
        ImGui::TextColored(ImVec4(0.55f, 1, 0.88f, 1), "%s · %.0f draws/s · target %.2f Hz", intent.playing() ? (audio.sampleRate() ? "Live" : "Waiting for audio device") : "Paused", actualFps, targetRate());
        ImGui::TextDisabled("Render %.2f ms · %.1f s / %.1f MiB history · %zu pending rows", renderMilliseconds, history.retainedSeconds(), history.payloadBytes() / 1048576.0, waterfallRenderer->pendingCount());
        ImGui::EndChild(); ImGui::End();
        ++frameCounter; const auto now = now100ns();
        if (now - fpsAt >= 10000000) { actualFps = frameCounter * 10000000.0 / (now - fpsAt); frameCounter = 0; fpsAt = now; }
        renderMilliseconds = (now - start) / 10000;
        if (!ImGui::GetIO().WantTextInput && ImGui::IsKeyPressed(ImGuiKey_Space)) intent.setPlaying(!intent.playing());
    }
};
PlayerUI::PlayerUI(HWND window, D3DDevice& graphics) : impl_(std::make_unique<Impl>(window, graphics)) {}
PlayerUI::~PlayerUI() = default;
void PlayerUI::tick() { impl_->tick(); }
void PlayerUI::draw() { impl_->draw(); }
void PlayerUI::open(const std::vector<std::filesystem::path>& paths) { impl_->open(paths); }
void PlayerUI::graphicsReset(D3DDevice& graphics) { impl_->resetGraphics(graphics); }
void PlayerUI::setDisplayRate(unsigned numerator, unsigned denominator) {
    if (numerator && denominator) { impl_->displayNumerator = numerator; impl_->displayDenominator = denominator; }
}
double PlayerUI::targetRate() const noexcept { return impl_->targetRate(); }
bool PlayerUI::continuous() const noexcept {
    return impl_->intent.playing() || (impl_->panel == 0 && impl_->settings.waterfall && impl_->waterfallRenderer->pendingCount());
}
void PlayerUI::setSmokeVolume() { impl_->smoke = true; impl_->settings.volume = 0; }
}
