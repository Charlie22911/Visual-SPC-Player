#include "PlayerUI.h"
#include "WorkspaceLayout.h"
#include "PlayerWidgets.h"
#include "About.h"
#include "audio/AudioEngine.h"
#include "model/Library.h"
#include "model/Settings.h"
#include "model/MapSampling.h"
#include "audio/SpectrumWorker.h"
#include "render/SpectrogramRenderer.h"
#include "model/SpectrumColors.h"
#include "model/PaletteTables.h"
#include "model/PresentationState.h"
#include "platform/Files.h"
#include "render/MapRenderer.h"
#include "render/WaterfallRenderer.h"
#include "imgui.h"
#include <shlwapi.h>
#include <psapi.h>
#include <fstream>
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
    SpectrumWorker spectrumWorker{audio.spectrum(),false};
    std::unique_ptr<SpectrogramRenderer> spectrumRenderer;
    unsigned spectrumWidth=1024,spectrumHeight=512;
    uint64_t spectrumEpoch=1,spectrumStagingDrops=0;
    std::vector<SpectrumResult> spectrumStaging=std::vector<SpectrumResult>(128);
    std::array<bool,128> spectrumStaged{};
    double spectrumReportAt=now100ns(),spectrumBegan=spectrumReportAt;
    std::deque<nlohmann::json> spectrumReport;

    std::unique_ptr<MapRenderer> mapRenderer;
    std::unique_ptr<WaterfallRenderer> waterfallRenderer;
    std::filesystem::path storage, root, folder;
    std::vector<Item> items;
    std::set<std::filesystem::path> knownPaths;
    std::vector<Row> browserRows;
    std::array<char, 256> search{};
    bool browserDirty = true, scanning = false, appliedPlaying = false;
    bool mapDirty = true, smoke = false;
    SidebarState sidebar;
    FooterText footerText;
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
    float headerMin=1e9f,headerMax=0;
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
            if (settings.spectrogram) panel = 3;
            try { if (std::filesystem::exists(storage / L"layout.json")) {
                const auto layout = nlohmann::json::parse(readText(storage / L"layout.json", 4096));
                sidebar.open = layout.value("libraryOpen", true);
                sidebar.pinned = layout.value("libraryPinned", false);
            } } catch (const std::exception&) { sidebar = {}; }
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
        spectrumRenderer.reset();
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
        if (settings.persistence && panel==0 && !settings.waterfall && settings.mode==0 && history.selected()) {
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
        ImGui::TextDisabled("%zu SPC files%s", items.size(), scanning ? " · scanning" : "");
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
        ImGui::BeginChild("Tracks", ImVec2(0, 0));
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
        ImGui::EndChild();
    }
    void transport() {
        const auto* current = track();
        const auto title = current ? (current->metadata.title[0] ? std::string(current->metadata.title) : utf8(current->path.stem().wstring())) : "Open an SPC file to begin";
        const auto seconds = static_cast<unsigned>(std::max(0.0, mediaFrame) / 32000);
        const auto actions = drawTransport(title, current ? current->metadata.game : "", status,
            seconds, intent.playing(), current != nullptr, settings.volume);
        if (actions.playPause) intent.setPlaying(!intent.playing());
        if (actions.restart && current) load(current->path, false);
        if (actions.volumeChanged) saveSettings();
    }
    SpectrumView spectrumView() const {
        SpectrumView v;
        v.width=spectrumWidth; v.height=spectrumHeight;
        v.fftSize=settings.spectrumFft; v.hopSize=settings.spectrumHop; v.sampling=settings.spectrumSampling;
        v.seconds=settings.spectrumSeconds; v.temporalMs=settings.spectrumTemporalMs; v.palette=settings.spectrumPalette;
        v.logarithmic=settings.spectrumLog; v.temporal=settings.spectrumTemporal; v.difference=settings.spectrumDifference;
        v.floorDb=settings.spectrumFloor; v.ceilingDb=settings.spectrumCeiling; return v;
    }
    void maintainGraphics(bool visible=true) {
        spectrumEpoch=spectrumWorker.setActive(panel==3 && visible);
        if(panel!=3 || !visible) {
            spectrumRenderer.reset(); spectrumStaged.fill(false);
            while(spectrumWorker.results().consumer_slot()) spectrumWorker.results().consume();
            return;
        }
        spectrumEpoch=spectrumWorker.configure(settings.spectrumFft,settings.spectrumHop);
        if(!spectrumRenderer) spectrumRenderer=std::make_unique<SpectrogramRenderer>(graphics->device.Get(),graphics->context.Get());
        try { spectrumRenderer->configure(spectrumView(),spectrumEpoch,anchor.generation); }
        catch(const std::exception& error) {
            if(FAILED(graphics->device->GetDeviceRemovedReason())) throw;
            status=error.what(); return;
        }
        const auto start=std::chrono::steady_clock::now();
        auto expired=[&] { return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()>0.6; };
        // Process staged generations in their original FIFO order; fixed storage bounds memory.
        for(size_t i=0;i<spectrumStaging.size();++i) if(spectrumStaged[i]) {
            const auto& r=spectrumStaging[i];
            if(r.stamp.analysisEpoch!=spectrumEpoch || r.stamp.generation<anchor.generation) spectrumStaged[i]=false;
        }
        while(!expired()) {
            size_t best=spectrumStaging.size();
            for(size_t i=0;i<spectrumStaging.size();++i) if(spectrumStaged[i] && spectrumStaging[i].stamp.generation==anchor.generation &&
                spectrumStaging[i].stamp.endFrame<=mediaFrame+16000 && (best==spectrumStaging.size() || spectrumStaging[i].stamp.rowSequence<spectrumStaging[best].stamp.rowSequence)) best=i;
            if(best==spectrumStaging.size()) break;
            spectrumRenderer->upload(spectrumStaging[best],mediaFrame); spectrumStaged[best]=false;
        }
        while(!expired()) {
            const auto* result=spectrumWorker.results().consumer_slot(); if(!result) break;
            if(result->stamp.analysisEpoch==spectrumEpoch && result->stamp.generation>=anchor.generation) {
                if(result->stamp.generation==anchor.generation && result->stamp.endFrame<=mediaFrame+16000)
                    spectrumRenderer->upload(*result,mediaFrame);
                else {
                    const auto free=std::find(spectrumStaged.begin(),spectrumStaged.end(),false);
                    if(free!=spectrumStaged.end()) { const auto i=static_cast<size_t>(free-spectrumStaged.begin()); spectrumStaging[i]=*result; spectrumStaged[i]=true; }
                    else ++spectrumStagingDrops;
                }
            }
            spectrumWorker.results().consume();
        }
    }
    void recordSpectrumReport() {
        const auto now=now100ns();
        if((smoke || settings.diagnostic) && now-spectrumReportAt>=10000000) {
            const auto s=spectrumRenderer?spectrumRenderer->stats():SpectrumRenderStats{};
            PROCESS_MEMORY_COUNTERS_EX mem{}; mem.cb=sizeof(mem);
            K32GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&mem),sizeof(mem));
            spectrumReport.push_back({{"seconds",(now-spectrumBegan)/10000000}, {"audibleFrame",mediaFrame},
                {"spectrumActive",spectrumWorker.active()},{"captureEnabled",audio.spectrum().captureEnabled()},{"panel",panel},
                {"generation",anchor.generation},{"analysed",spectrumWorker.analysedRows()},{"consumedPackets",spectrumWorker.consumedPackets()},
                {"workerDropped",spectrumWorker.droppedResults()},{"stagingDropped",spectrumStagingDrops},{"uploaded",s.uploaded},
                {"pcmQueued",audio.spectrum().approximate_size()},{"resultQueued",spectrumWorker.results().approximate_size()},
                {"pcmHighWater",spectrumWorker.pcmHighWater()},{"resultHighWater",spectrumWorker.resultHighWater()},
                {"pcmDropped",audio.spectrum().dropped()},{"newestAnalysedGeneration",spectrumWorker.newestGeneration()},
                {"newestAnalysedFrame",spectrumWorker.newestFrame()},
                {"projected",s.projected},{"draws",s.draws},{"pending",s.pending},{"graphicsBytes",s.bytes},
                {"privateBytes",mem.PrivateUsage},{"workingSet",mem.WorkingSetSize},{"uiDrawMs",renderMilliseconds},
                {"uploadSubmitMs",s.uploadMs},{"projectionSubmitMs",s.projectionMs},{"drawSubmitMs",s.drawMs},{"status",status}});
            if(spectrumReport.size()>4096) spectrumReport.pop_front(); spectrumReportAt=now;
        }
    }
    void zoomWaterfall(double factor, double anchorFraction = 0.5) {
        const double address = waterfallStart + waterfallSpan * anchorFraction;
        waterfallSpan = static_cast<uint32_t>(std::clamp(std::round(waterfallSpan * factor), 1.0, 65536.0));
        waterfallStart = static_cast<uint32_t>(std::clamp(std::round(address - waterfallSpan * anchorFraction), 0.0, 65536.0 - waterfallSpan));
        waterfallFit = false;
    }
    void spectrogramPanel() {
        FlowToolbar row;
        const float controlDpi=ImGui::GetStyle().FontScaleDpi;
        bool changed=false, custom=false;
        row.next(160*controlDpi); ImGui::SetNextItemWidth(160*controlDpi);
        if(ImGui::Combo("##spectrumPreset",&settings.spectrumPreset,"Balanced\0Transient detail\0Frequency detail\0Raw analysis\0Custom\0")) {
            changed=true;
            if(settings.spectrumPreset<4) {
                settings.spectrumFft=settings.spectrumPreset==1?1024:settings.spectrumPreset==2?4096:2048;
                settings.spectrumHop=settings.spectrumPreset==1?64:256;
                settings.spectrumSampling=settings.spectrumPreset==3?0:1;
                settings.spectrumTemporal=settings.spectrumPreset==0 || settings.spectrumPreset==2;
                settings.spectrumTemporalMs=settings.spectrumTemporal?25:0;
            }
        }
        row.next(FlowToolbar::toggleWidth("Stereo difference")); changed |= ImGui::Checkbox("Stereo difference",&settings.spectrumDifference);
        if(ImGui::IsItemHovered()) ImGui::SetTooltip("Brightness = strength of (Left - Right) / 2. Identical channels are black; phase differences are included. Uses the dBFS floor/top controls.");
        row.next(125*controlDpi); ImGui::SetNextItemWidth(125*controlDpi);
        ImGui::BeginDisabled(settings.spectrumDifference);
        changed |= ImGui::Combo("##spectrumPalette",&settings.spectrumPalette,"Green\0Heat\0Grayscale\0");
        ImGui::EndDisabled();
        if(ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) ImGui::SetTooltip(settings.spectrumDifference ? "Stereo difference uses grayscale brightness." : "Spectrogram colour: quiet levels are dark, strong levels are bright. Independent of the ARAM palette.");
        row.next(110*controlDpi);
        {
            const auto at=ImGui::GetCursorScreenPos(); const float height=ImGui::GetFrameHeight();
            ImGui::Dummy(ImVec2(110*controlDpi,height));
            auto* colors=ImGui::GetWindowDrawList();
            for(unsigned i=0;i<110;++i) colors->AddRectFilled(ImVec2(at.x+i*controlDpi,at.y+height*0.25f),ImVec2(at.x+(i+1)*controlDpi,at.y+height*0.75f),spectrumColor(i*255/109,settings.spectrumDifference?2:settings.spectrumPalette));
            if(ImGui::IsItemHovered()) ImGui::SetTooltip("Left: %.0f dBFS floor; right: %.0f dBFS top",settings.spectrumFloor,settings.spectrumCeiling);
        }
        row.next(120*controlDpi); ImGui::SetNextItemWidth(120*controlDpi);
        custom |= ImGui::Combo("##spectrumSampling",&settings.spectrumSampling,"Nearest\0Smooth\0Area\0");
        row.next(FlowToolbar::toggleWidth("Log frequency")); changed |= ImGui::Checkbox("Log frequency",&settings.spectrumLog);
        row.next(100*controlDpi); ImGui::SetNextItemWidth(100*controlDpi);
        int fft=settings.spectrumFft==1024?0:settings.spectrumFft==2048?1:2;
        if(ImGui::Combo("##fftSize",&fft,"FFT 1024\0FFT 2048\0FFT 4096\0")) { settings.spectrumFft=1024<<fft; custom=true; }
        row.next(110*controlDpi); ImGui::SetNextItemWidth(110*controlDpi);
        int hop=settings.spectrumHop==64?0:settings.spectrumHop==128?1:settings.spectrumHop==256?2:3;
        if(ImGui::Combo("##analysisHop",&hop,"Hop 64\0Hop 128\0Hop 256\0Hop 512\0")) { settings.spectrumHop=64<<hop; custom=true; }
        if(ImGui::IsItemHovered()) ImGui::SetTooltip("Samples between analyses: smaller values give more closely spaced time rows at higher processing cost.");
        row.next(FlowToolbar::toggleWidth("Temporal smoothing")); if(ImGui::Checkbox("Temporal smoothing",&settings.spectrumTemporal)) { custom=true; if(settings.spectrumTemporal && !settings.spectrumTemporalMs) settings.spectrumTemporalMs=25; }
        if(settings.spectrumTemporal) { row.next(130*controlDpi); ImGui::SetNextItemWidth(130*controlDpi); custom |= ImGui::SliderInt("##spectrumTemporalMs",&settings.spectrumTemporalMs,1,200,"%d ms"); }
        row.next(90*controlDpi); ImGui::SetNextItemWidth(90*controlDpi);
        const char* durations[]={"2 s","5 s","10 s"}; int duration=settings.spectrumSeconds==2?0:settings.spectrumSeconds==5?1:2;
        if(ImGui::Combo("##spectrumSeconds",&duration,durations,3)) { settings.spectrumSeconds=duration==0?2:duration==1?5:10; changed=true; }
        row.next(130*controlDpi); ImGui::SetNextItemWidth(130*controlDpi);
        changed |= ImGui::SliderFloat("##floor",&settings.spectrumFloor,-120,-30,"Floor %.0f dBFS");
        row.next(130*controlDpi); ImGui::SetNextItemWidth(130*controlDpi);
        changed |= ImGui::SliderFloat("##ceiling",&settings.spectrumCeiling,-30,0,"Top %.0f dBFS");
        if(custom) { settings.spectrumPreset=4; changed=true; }
        if(changed) saveSettings();
        // The tab may have been selected during this frame, after main-loop
        // maintenance ran for the previously active tab.
        if(!spectrumRenderer) maintainGraphics();
        const auto origin=ImGui::GetCursorScreenPos(), available=ImGui::GetContentRegionAvail();
        const float dpi=ImGui::GetStyle().FontScaleDpi;
        const auto fb=ImGui::GetIO().DisplayFramebufferScale;
        const ImVec2 graph(std::round((origin.x+45*dpi)*fb.x)/fb.x,std::round((origin.y+22*dpi)*fb.y)/fb.y);
        const ImVec2 size(std::max(1.0f,std::floor((origin.x+available.x-graph.x)*fb.x))/fb.x,std::max(1.0f,std::floor((origin.y+available.y-graph.y)*fb.y))/fb.y);
        ImGui::InvisibleButton("##spectrum",ImVec2(std::max(1.0f,available.x),std::max(1.0f,available.y)));
        const unsigned w=std::max(1u,static_cast<unsigned>(std::round(size.x*fb.x))),h=std::max(1u,static_cast<unsigned>(std::round(size.y*fb.y)));
        spectrumWidth=w; spectrumHeight=h;
        spectrumEpoch=spectrumWorker.configure(settings.spectrumFft,settings.spectrumHop);
        spectrumRenderer->configure(spectrumView(),spectrumEpoch,anchor.generation);
        spectrumRenderer->update();
        spectrumRenderer->draw(mediaFrame);
        const auto frequency=[&](double fraction) { return settings.spectrumLog ? 20.0*std::pow(800.0,fraction) : 16000.0*fraction; };
        auto* draw=ImGui::GetWindowDrawList();
        draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerNearest,nullptr);
        draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(spectrumRenderer->texture())),graph,ImVec2(graph.x+size.x,graph.y+size.y));
        draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerLinear,nullptr);
        for(unsigned tick=0;tick<=4;++tick) {
            char label[48]; std::snprintf(label,sizeof(label),"%.0f Hz",frequency(tick/4.0));
            draw->AddText(ImVec2(graph.x+(size.x-65*dpi)*tick/4,origin.y),IM_COL32(190,210,220,255),label);
            std::snprintf(label,sizeof(label),"-%.1fs",settings.spectrumSeconds*tick/4.0);
            draw->AddText(ImVec2(origin.x,graph.y+(size.y-ImGui::GetTextLineHeight())*tick/4),IM_COL32(190,210,220,255),label);
        }
        if(ImGui::IsItemHovered()) {
            const auto mouse=ImGui::GetIO().MousePos;
            const double f=frequency(std::clamp((mouse.x-graph.x)/size.x,0.0f,1.0f));
            ImGui::SetTooltip("%.1f Hz; %.3f s ago\n%s; Hann %d, hop %d; 32 kHz, pre-volume",f,std::clamp((mouse.y-graph.y)/size.y,0.0f,1.0f)*settings.spectrumSeconds,settings.spectrumDifference?"Stereo difference (L-R)/2":"Stereo power",settings.spectrumFft,settings.spectrumHop);
        }
        footerText.legend=settings.spectrumDifference?"Brightness: (L-R)/2 power; identical channels black; includes phase differences":"Power before playback volume; 0 dBFS = full-scale sine";
        footerText.inspection="Spectrogram: stereo audio power / dBFS; frequency left to right, newest audio at top";
    }
    void memoryPanel() {
        bool changed = false;
        FlowToolbar controls;
        controls.next(FlowToolbar::toggleWidth("Map"));
        if (ImGui::RadioButton("Map", !settings.waterfall)) { settings.waterfall = false; changed = true; }
        controls.next(FlowToolbar::toggleWidth("Waterfall"));
        if (ImGui::RadioButton("Waterfall", settings.waterfall)) { settings.waterfall = true; changed = true; }
        controls.next(120 * ImGui::GetStyle().FontScaleDpi); ImGui::SetNextItemWidth(120 * ImGui::GetStyle().FontScaleDpi);
        changed |= ImGui::Combo("##measurement", &settings.mode, "Activity\0Data\0Entropy\0");
        controls.next(FlowToolbar::toggleWidth("Byte")); bool& bits = settings.selectedBits();
        if (ImGui::RadioButton("Byte", !bits)) { bits = false; changed = true; }
        controls.next(FlowToolbar::toggleWidth("Bit")); if (ImGui::RadioButton("Bit", bits)) { bits = true; changed = true; }
        controls.next(FlowToolbar::buttonWidth("-"));
        if (ImGui::Button("-")) { if (settings.waterfall) zoomWaterfall(2); else { mapScale = clampMapScale(mapScale * 0.5f); mapFit = false; } }
        controls.next(FlowToolbar::buttonWidth("Fit"));
        if (ImGui::Button("Fit")) { if (settings.waterfall) { waterfallStart = 0; waterfallSpan = 65536; waterfallFit = true; } else mapFit = true; }
        controls.next(FlowToolbar::buttonWidth("1:1"));
        if (ImGui::Button("1:1")) { if (settings.waterfall) { waterfallSpan = std::max(1u, lastColumns); waterfallStart = std::min(waterfallStart, 65536 - waterfallSpan); waterfallFit = false; } else { mapScale = 1 / (ImGui::GetStyle().FontScaleDpi * ImGui::GetIO().DisplayFramebufferScale.x); mapFit = false; } }
        controls.next(FlowToolbar::buttonWidth("+"));
        if (ImGui::Button("+")) { if (settings.waterfall) zoomWaterfall(0.5); else { mapScale = clampMapScale(mapScale * 2); mapFit = false; } }
        if (settings.waterfall) {
            controls.next(65 * ImGui::GetStyle().FontScaleDpi);
            ImGui::SetNextItemWidth(65 * ImGui::GetStyle().FontScaleDpi); int duration = settings.seconds == 2 ? 0 : settings.seconds == 5 ? 1 : 2;
            if (ImGui::Combo("##duration", &duration, "2 s\0" "5 s\0" "10 s\0")) { settings.seconds = duration == 0 ? 2 : duration == 1 ? 5 : 10; changed = true; }
        }
        if (settings.mode == 1) { controls.next(FlowToolbar::toggleWidth("XOR")); changed |= ImGui::Checkbox("XOR", &settings.xorData); }
        if (settings.mode == 0) { controls.next(FlowToolbar::toggleWidth("Show data underneath")); changed |= ImGui::Checkbox("Show data underneath", &settings.underlay); }
        {
            controls.next(130 * ImGui::GetStyle().FontScaleDpi);
            ImGui::SetNextItemWidth(130 * ImGui::GetStyle().FontScaleDpi);
            int& samplingChoice = settings.waterfall ? settings.waterfallSampling : settings.mapSampling;
            changed |= ImGui::Combo("##sampling", &samplingChoice, "Nearest\0Smooth\0Area\0");
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("Sampling: Nearest selects cells; Smooth blends colors; Area summarizes covered cells and preserves activity.");
        }
        if(settings.waterfall) {
            controls.next(FlowToolbar::toggleWidth("Temporal smoothing"));
            ImGui::BeginDisabled(settings.mode==0 && !settings.underlay);
            changed |= ImGui::Checkbox("Temporal smoothing", &settings.waterfallTemporal);
            ImGui::EndDisabled();
            if(ImGui::IsItemHovered()) ImGui::SetTooltip("Time-based numeric low-pass for Data, Entropy and the data underlay. Activity markers retain their original timing.");
            if(settings.waterfallTemporal) { controls.next(150*ImGui::GetStyle().FontScaleDpi); ImGui::SetNextItemWidth(150*ImGui::GetStyle().FontScaleDpi); changed |= ImGui::SliderInt("##temporalDuration",&settings.waterfallTemporalMs,10,200,"%d ms"); }
        }
        if (changed) saveSettings();
        const auto available = ImGui::GetContentRegionAvail();
        const ImVec2 plotSize(std::max(1.0f, available.x), std::max(1.0f, available.y));
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

            mapAccess.drawn();
            const float cell = physicalMapScale(mapScale, dpi);
            ImVec2 top(origin.x + plotSize.x / 2 - mapCenterX * width * cell,
                origin.y + plotSize.y / 2 - mapCenterY * height * cell);
            const auto fb = ImGui::GetIO().DisplayFramebufferScale;
            if (cell * fb.x >= 1 && std::abs(cell * fb.x - std::round(cell * fb.x)) < 0.0001f) { top.x = std::round(top.x * fb.x) / fb.x; top.y = std::round(top.y * fb.y) / fb.y; }
            const bool area = settings.mapSampling == 2 && (cell * fb.x < 1 || cell * fb.y < 1);
            if (area) {
                const ImVec2 targetOrigin(std::floor(origin.x * fb.x) / fb.x, std::floor(origin.y * fb.y) / fb.y);
                const unsigned targetWidth = static_cast<unsigned>(std::ceil((origin.x + plotSize.x) * fb.x) - targetOrigin.x * fb.x);
                const unsigned targetHeight = static_cast<unsigned>(std::ceil((origin.y + plotSize.y) * fb.y) - targetOrigin.y * fb.y);
                mapRenderer->draw(view, settings.palette, settings.persistence, targetWidth, targetHeight,
                    (top.x - targetOrigin.x) * fb.x, (top.y - targetOrigin.y) * fb.y, cell * fb.x, cell * fb.y);
                draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(mapRenderer->texture())), targetOrigin,
                    ImVec2(targetOrigin.x + targetWidth / fb.x, targetOrigin.y + targetHeight / fb.y));
            } else {
                mapRenderer->draw(view, settings.palette, settings.persistence);
                if (settings.mapSampling == 1) draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerLinear, nullptr);
                draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(mapRenderer->texture())), top,
                    ImVec2(top.x + width * cell, top.y + height * cell));
                draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerNearest, nullptr);
            }
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
                if (area) {
                    const double px = std::floor(mouse.x * fb.x) / fb.x, py = std::floor(mouse.y * fb.y) / fb.y;
                    const auto summary = summarizeMap(*selected, history.previous(*selected), mapAccess.bytes(), mapEntropy,
                        view.bits, view.changesOnly, view.measurement == Measurement::Entropy,
                        (px-top.x)/cell, (py-top.y)/cell, (px+1/fb.x-top.x)/cell, (py+1/fb.y-top.y)/cell, &visibleKinds);
                    ImGui::BeginTooltip();
                    ImGui::TextUnformatted(buffer);
                    if (!view.changesOnly || history.previous(*selected)) ImGui::Text("Pixel summary: %u %s cells; mean %.5f%s", summary.cells, view.bits ? "bit" : "byte", summary.mean,
                        view.measurement == Measurement::Entropy ? " local entropy" : view.bits ? " fraction" : " byte value");
                    ImGui::Text("%u distinct bytes", summary.bytes);
                    if (settings.persistence && ((settings.mode == 0 && !view.underlay) || (settings.mode == 1 && !view.changesOnly))) ImGui::Text("Held activity flags: %u", summary.held);
                    const unsigned shownKinds = settings.mode == 0 && settings.persistence && !view.underlay ? summary.held : summary.kinds;
                    ImGui::Text("Any activity across cells: R:%u W:%u X:%u", shownKinds&1, (shownKinds>>1)&1, (shownKinds>>2)&1);
                    if (view.changesOnly) ImGui::TextUnformatted(history.previous(*selected) ? (summary.changed ? "Changes present" : "No changes") : "XOR baseline unavailable");
                    ImGui::EndTooltip();
                }
                inspection = std::string(buffer) + (area ? " · area summary" : settings.mapSampling == 1 ? " · smoothed colors" : "");
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
            const auto fb = ImGui::GetIO().DisplayFramebufferScale;
            waterfallRenderer->draw(settings.palette, settings.waterfallSampling,
                static_cast<unsigned>(std::max(1.0f,std::round(graphSize.x*fb.x))),
                static_cast<unsigned>(std::max(1.0f,std::round(graphSize.y*fb.y))), settings.waterfallTemporal, static_cast<unsigned>(settings.waterfallTemporalMs));
            if(settings.waterfallSampling==1) draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerLinear,nullptr);
            draw->AddImage(ImTextureRef(reinterpret_cast<ImTextureID>(waterfallRenderer->texture())), graphOrigin, ImVec2(graphOrigin.x + graphSize.x, graphOrigin.y + graphSize.y));
            draw->AddCallback(ImGui::GetPlatformIO().DrawCallback_SetSamplerNearest,nullptr);
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
                inspection = std::string(buffer) + (settings.waterfallSampling == 1 ? " (smoothed colors; inspected source bucket)" : settings.waterfallSampling == 2 ? " (Area sampling; inspected source bucket)" : "");
            }
        }
        clipping.end();
        if (!inspection.empty()) footerText.inspection = std::move(inspection);
    }
    double targetRate() const noexcept { return settings.rate ? settings.rate : static_cast<double>(displayNumerator) / displayDenominator; }
    void voicePanel() {
        const auto* snapshot = history.selected();
        if (!snapshot) { ImGui::TextUnformatted("Open an SPC file."); return; }
        drawVoiceTable(std::span<const uint8_t, 128>(snapshot->state.data() + 160, 128));
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
            const auto spectrumStats=spectrumRenderer?spectrumRenderer->stats():SpectrumRenderStats{};
            ImGui::Text("Spectrum: %llu analyses · %llu draws · %zu pending · %.1f MiB graphics",spectrumWorker.analysedRows(),spectrumStats.draws,spectrumStats.pending,spectrumStats.bytes/1048576.0);
            ImGui::Text("Spectrum drops: worker %llu · staging %llu",spectrumWorker.droppedResults(),spectrumStagingDrops);
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
        ImGui::Begin("Visual SPC Player", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings | fixedRegionFlags);
        transport();
        const float header=ImGui::GetCursorScreenPos().y-ImGui::GetWindowPos().y;
        headerMin=std::min(headerMin,header); headerMax=std::max(headerMax,header);
        footerText = {};
        if (panel == 0) {
            footerText.inspection = "Scroll to zoom · drag to pan · hover to inspect";
            footerText.legend = settings.mode == 0 ? "Read (blue) · Write (green) · Execute (amber) · overlaps blend" :
                settings.mode == 2 ? (settings.entropyBits ? "Entropy: 0–1 bits per bit position · 256-byte blocks" : "Entropy: 0–8 bits per byte · 256-byte blocks") : "Data describes the selected captured state";
        }
        const bool layoutChanged = drawWorkspace(sidebar, [&] {
            FlowToolbar tabs;
            for (int i = 0; i < 7; ++i) {
                const auto label = std::array{"ARAM", "Voices", "DSP", "Spectrogram", "Track", "Settings", "About"}[i];
                const float width = std::max(70 * ImGui::GetStyle().FontScaleDpi, FlowToolbar::buttonWidth(label));
                tabs.next(width);
                if (ImGui::Selectable(label, panel == i, 0, ImVec2(width, 0))) {
                    panel = i;
                    if(panel!=3) maintainGraphics();
                    if (settings.spectrogram != (panel == 3)) { settings.spectrogram = panel == 3; saveSettings(); }
                }
            }
            ImGui::Separator();
            ImGui::BeginChild("Panel content", ImVec2(0, 0), 0, (panel == 0 || panel == 3) ? fixedRegionFlags : 0);
            try {
                if (panel == 0) memoryPanel(); else if (panel == 1) voicePanel();
                else if (panel == 2) dspPanel(); else if (panel == 3) spectrogramPanel();
                else if (panel == 4) trackPanel(); else if (panel == 5) settingsPanel();
                else if (drawAbout()) {
                    const auto path = chooseSave(window, L"Visual-SPC-Player-source.zip", true);
                    if (!path.empty()) {
                        const auto source = embeddedSource();
                        status = library.save(path, std::string(source)) ? "" : "Source ZIP could not be saved. Try again.";
                    }
                }
            } catch (const std::exception& error) { if(FAILED(graphics->device->GetDeviceRemovedReason())) throw; status = error.what(); }
            ImGui::EndChild();
        }, [&] {
            try { libraryPanel(); } catch (const std::exception& error) { status = error.what(); }
        }, [&] {
            char live[180], performance[220];
            std::snprintf(live, sizeof(live), "%s · %.0f draws/s · target %.2f Hz", intent.playing() ? (audio.sampleRate() ? "Live" : "Waiting for audio device") : "Paused", actualFps, targetRate());
            std::snprintf(performance, sizeof(performance), "Render %.2f ms · %.1f s / %.1f MiB history · %zu pending rows", renderMilliseconds, history.retainedSeconds(), history.payloadBytes() / 1048576.0, waterfallRenderer->pendingCount());
            footerText.live = live; footerText.performance = performance;
            return footerText;
        });
        if (layoutChanged && !smoke && !storage.empty())
            if (!library.save(storage / L"layout.json", nlohmann::json{{"libraryOpen", sidebar.open}, {"libraryPinned", sidebar.pinned}}.dump(2)))
                status = "The file worker is busy; library layout has not been saved.";
        ImGui::End();
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
void PlayerUI::maintainGraphics(bool visible) { impl_->maintainGraphics(visible); impl_->recordSpectrumReport(); }
void PlayerUI::setSmokePanel(unsigned panel) { if(impl_->smoke && panel<7) impl_->panel=static_cast<int>(panel); }
void PlayerUI::open(const std::vector<std::filesystem::path>& paths) { impl_->open(paths); }
void PlayerUI::graphicsReset(D3DDevice& graphics) { impl_->resetGraphics(graphics); }
void PlayerUI::setDisplayRate(unsigned numerator, unsigned denominator) {
    if (numerator && denominator) { impl_->displayNumerator = numerator; impl_->displayDenominator = denominator; }
}
double PlayerUI::targetRate() const noexcept { return impl_->targetRate(); }
bool PlayerUI::continuous() const noexcept {
    return impl_->intent.playing() || (impl_->panel == 0 && impl_->settings.waterfall && impl_->waterfallRenderer->pendingCount()) ||
        (impl_->panel == 3 && impl_->spectrumRenderer && impl_->spectrumRenderer->stats().pending);
}
void PlayerUI::setSmokeVolume(bool spectrogram,bool stress) { impl_->smoke = true; impl_->settings.volume = 0; if(spectrogram) { impl_->panel=3; impl_->settings.spectrogram=true; impl_->settings.spectrumDifference=true; impl_->settings.spectrumFft=4096; impl_->settings.spectrumHop=stress?64:256; if(stress) { impl_->settings.spectrumSampling=2; impl_->settings.spectrumSeconds=10; impl_->settings.spectrumTemporal=true; impl_->settings.spectrumTemporalMs=200; } } }
void PlayerUI::writeSpectrumReport(const std::filesystem::path& path) {
    const auto& s=impl_->settings;
    std::ofstream out(path);
    out<<nlohmann::json{{"adapter",utf8(impl_->graphics->adapterName)},{"software",impl_->graphics->software},
        {"width",impl_->spectrumWidth},{"height",impl_->spectrumHeight},{"fft",s.spectrumFft},{"hop",s.spectrumHop},
        {"sampling",s.spectrumSampling},{"temporalMs",s.spectrumTemporalMs},{"targetHz",impl_->targetRate()},
        {"headerMin",impl_->headerMin},{"headerMax",impl_->headerMax},{"samples",impl_->spectrumReport}}.dump(2);
}
}
