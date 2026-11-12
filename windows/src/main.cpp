#include <Windows.h>
#include <shellapi.h>
#include <algorithm>
#include <chrono>
#include <vector>
#include "ui/PlayerUI.h"
#include "platform/Files.h"
#include "model/PresentationState.h"
#include "imgui.h"
#include "backends/imgui_impl_win32.h"
#include "backends/imgui_impl_dx11.h"
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND, UINT, WPARAM, LPARAM);
namespace {
visual_spc::PlayerUI* player = nullptr;
unsigned resizeWidth = 0, resizeHeight = 0;
bool minimized = false, dpiChanged = false;
LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (ImGui_ImplWin32_WndProcHandler(window, message, wparam, lparam)) return TRUE;
    switch (message) {
    case WM_SIZE:
        minimized = wparam == SIZE_MINIMIZED;
        if (!minimized) { resizeWidth = LOWORD(lparam); resizeHeight = HIWORD(lparam); }
        return 0;
    case WM_DPICHANGED: {
        const auto* rect = reinterpret_cast<const RECT*>(lparam);
        SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
        dpiChanged = true; return 0;
    }
    case WM_GETMINMAXINFO: {
        const auto dpi = GetDpiForWindow(window);
        const float scale = (dpi ? dpi : GetDpiForSystem()) / 96.0f;
        MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor);
        GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
        reinterpret_cast<MINMAXINFO*>(lparam)->ptMinTrackSize = {
            std::min(static_cast<LONG>(1000 * scale), monitor.rcWork.right - monitor.rcWork.left),
            std::min(static_cast<LONG>(640 * scale), monitor.rcWork.bottom - monitor.rcWork.top)};
        return 0;
    }
    case WM_DROPFILES: {
        const auto drop = reinterpret_cast<HDROP>(wparam);
        std::vector<std::filesystem::path> paths;
        const auto count = DragQueryFileW(drop, 0xffffffff, nullptr, 0);
        for (UINT i = 0; i < count; ++i) {
            const auto length = DragQueryFileW(drop, i, nullptr, 0);
            std::wstring path(length + 1, 0); DragQueryFileW(drop, i, path.data(), length + 1); path.resize(length);
            paths.emplace_back(path);
        }
        DragFinish(drop);
        if (player) try { player->open(paths); } catch (...) {}
        return 0;
    }
    case WM_SYSCOMMAND: if ((wparam & 0xfff0) == SC_KEYMENU) return 0; break;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}
std::pair<unsigned, unsigned> refreshRate(HWND window) {
    MONITORINFOEXW monitor{}; monitor.cbSize = sizeof(monitor);
    GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
    UINT32 pathCount = 0, modeCount = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) == ERROR_SUCCESS) {
        std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
        std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
        if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount, modes.data(), nullptr) == ERROR_SUCCESS)
            for (UINT32 i = 0; i < pathCount; ++i) {
                DISPLAYCONFIG_SOURCE_DEVICE_NAME name{};
                name.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(name), paths[i].sourceInfo.adapterId, paths[i].sourceInfo.id};
                if (DisplayConfigGetDeviceInfo(&name.header) == ERROR_SUCCESS && _wcsicmp(name.viewGdiDeviceName, monitor.szDevice) == 0) {
                    const auto refresh = paths[i].targetInfo.refreshRate;
                    if (refresh.Numerator && refresh.Denominator) return {refresh.Numerator, refresh.Denominator};
                }
            }
    }
    DEVMODEW mode{}; mode.dmSize = sizeof(mode);
    if (EnumDisplaySettingsW(monitor.szDevice, ENUM_CURRENT_SETTINGS, &mode) && mode.dmDisplayFrequency > 1) return {mode.dmDisplayFrequency, 1};
    return {60, 1};
}
void theme(float scale) {
    ImGui::GetStyle() = ImGuiStyle();
    ImGui::StyleColorsDark();
    auto& style = ImGui::GetStyle();
    style.WindowRounding = 0; style.ChildRounding = 8; style.FrameRounding = 6; style.GrabRounding = 6;
    style.FramePadding = ImVec2(9, 6); style.ItemSpacing = ImVec2(9, 8);
    style.Colors[ImGuiCol_WindowBg] = ImVec4(0.025f, 0.045f, 0.075f, 1);
    style.Colors[ImGuiCol_ChildBg] = ImVec4(0.03f, 0.055f, 0.085f, 1);
    style.Colors[ImGuiCol_Button] = ImVec4(0.06f, 0.12f, 0.16f, 1);
    style.Colors[ImGuiCol_ButtonHovered] = ImVec4(0.1f, 0.3f, 0.3f, 1);
    style.Colors[ImGuiCol_Header] = ImVec4(0.06f, 0.23f, 0.23f, 1);
    style.Colors[ImGuiCol_CheckMark] = ImVec4(0.4f, 1, 0.85f, 1);
    style.Colors[ImGuiCol_SliderGrab] = ImVec4(0.4f, 1, 0.85f, 1);
    style.ScaleAllSizes(scale); style.FontScaleDpi = scale;
}
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    HWND window = nullptr;
    bool imgui = false, winBackend = false, dxBackend = false;
    int result = 0;
    try {
        if (FAILED(com)) throw std::runtime_error("COM initialization failed");
        WNDCLASSEXW cls{sizeof(cls)};
        cls.style = CS_CLASSDC; cls.lpfnWndProc = windowProcedure; cls.hInstance = instance;
        cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(101));
        cls.lpszClassName = L"VisualSPCPlayerWindow";
        if (!RegisterClassExW(&cls)) throw std::runtime_error("Window registration failed");
        window = CreateWindowExW(0, cls.lpszClassName, L"Visual SPC Player", WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, 1400, 940, nullptr, nullptr, instance, nullptr);
        if (!window) throw std::runtime_error("Window creation failed");
        auto graphics = std::make_unique<visual_spc::D3DDevice>(window);
        IMGUI_CHECKVERSION(); ImGui::CreateContext(); imgui = true;
        auto& io = ImGui::GetIO(); io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        io.IniFilename = nullptr;
        io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16);
        theme(GetDpiForWindow(window) / 96.0f);
        if (!ImGui_ImplWin32_Init(window)) throw std::runtime_error("ImGui Win32 initialization failed"); winBackend = true;
        if (!ImGui_ImplDX11_Init(graphics->device.Get(), graphics->context.Get())) throw std::runtime_error("ImGui DX11 initialization failed"); dxBackend = true;
        visual_spc::PlayerUI ui(window, *graphics); player = &ui;
        DragAcceptFiles(window, TRUE);
        int argc = 0; auto** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        unsigned smokeSeconds = 0; bool smokeSpectrum = false,smokeStress=false,smokeLifecycle=false;
        std::filesystem::path spectrumReport;
        std::vector<std::filesystem::path> paths;
        if (argv) {
            for (int i = 1; i < argc; ++i) {
                if (std::wstring(argv[i]) == L"--smoke-seconds" && i + 1 < argc) smokeSeconds = static_cast<unsigned>(_wtoi(argv[++i]));
                else if (std::wstring(argv[i]) == L"--smoke-spectrogram" && i + 1 < argc) { smokeSpectrum=true; smokeSeconds=static_cast<unsigned>(_wtoi(argv[++i])); }
                else if (std::wstring(argv[i]) == L"--smoke-spectrum-lifecycle" && i+1<argc) { smokeSpectrum=true; smokeLifecycle=true; smokeSeconds=static_cast<unsigned>(_wtoi(argv[++i])); }
                else if (std::wstring(argv[i]) == L"--spectrum-stress") smokeStress=true;
                else if (std::wstring(argv[i]) == L"--spectrum-report" && i+1<argc) spectrumReport=argv[++i];
                else paths.emplace_back(argv[i]);
            }
            LocalFree(argv);
        }
        if (smokeSeconds) ui.setSmokeVolume(smokeSpectrum,smokeStress);
        if (!paths.empty()) ui.open(paths);
        ShowWindow(window, show); UpdateWindow(window);
        LARGE_INTEGER frequency{}; QueryPerformanceFrequency(&frequency);
        double deadline = 0;
        double previousRate = 0;
        HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
        if (!timer) timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
        if (!timer) throw std::runtime_error("Frame pacing timer is unavailable");
        const auto began = std::chrono::steady_clock::now();
        auto refreshAt = began - std::chrono::seconds(2);
        bool quit = false; unsigned lifecyclePhase=0;
        while (!quit) {
            MSG message{};
            bool messages = false;
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                messages = true;
                if (message.message == WM_QUIT) quit = true;
                TranslateMessage(&message); DispatchMessageW(&message);
            }
            if (quit) break;
            ui.tick();
            const auto now = std::chrono::steady_clock::now();
            if (smokeSeconds && now - began >= std::chrono::seconds(smokeSeconds)) { if(!spectrumReport.empty()) ui.writeSpectrumReport(spectrumReport); DestroyWindow(window); continue; }
            if(smokeLifecycle && smokeSeconds) {
                const auto elapsed=std::chrono::duration<double>(now-began).count();
                const unsigned phase=std::min(4u,static_cast<unsigned>(elapsed*5/smokeSeconds));
                if(phase!=lifecyclePhase) {
                    lifecyclePhase=phase; ui.setSmokePanel(phase%2==0?3:phase==1?0:4);
                    if(phase==3 && !paths.empty()) ui.open(paths);
                }
            }
            if (now - refreshAt > std::chrono::seconds(1)) { const auto refresh = refreshRate(window); ui.setDisplayRate(refresh.first, refresh.second); refreshAt = now; }
            if (dpiChanged) { theme(GetDpiForWindow(window) / 96.0f); dpiChanged = false; }
            try {
                if (resizeWidth && resizeHeight) { graphics->resize(resizeWidth, resizeHeight); resizeWidth = resizeHeight = 0; }
                ui.maintainGraphics(!minimized);
                if (minimized) { MsgWaitForMultipleObjectsEx(0, nullptr, 33, QS_ALLINPUT, MWMO_INPUTAVAILABLE); continue; }
                LARGE_INTEGER ticks{}; QueryPerformanceCounter(&ticks);
                const double selected = visual_spc::effectiveDrawRate(ui.targetRate(), ui.continuous());
                const double current = static_cast<double>(ticks.QuadPart), period = static_cast<double>(frequency.QuadPart) / selected;
                if (selected != previousRate || (messages && !ui.continuous())) deadline = current;
                previousRate = selected;
                if (deadline < current - period) deadline = current;
                if (current < deadline) {
                    LARGE_INTEGER due{}; due.QuadPart = -static_cast<LONGLONG>((deadline - current) * 10000000 / frequency.QuadPart);
                    SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
                    MsgWaitForMultipleObjectsEx(1, &timer, 1000, QS_ALLINPUT, MWMO_INPUTAVAILABLE); continue;
                }
                const auto latency = graphics->latencyHandle();
                if (MsgWaitForMultipleObjectsEx(1, &latency, 1000, QS_ALLINPUT, MWMO_INPUTAVAILABLE) != WAIT_OBJECT_0) continue;
                ImGui_ImplDX11_NewFrame(); ImGui_ImplWin32_NewFrame(); ImGui::NewFrame();
                ui.draw(); ImGui::Render(); graphics->begin(); ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
                const auto presented = graphics->present();
                if (presented == DXGI_STATUS_OCCLUDED) MsgWaitForMultipleObjectsEx(0, nullptr, 33, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                visual_spc::checkGpu(presented);
                deadline += period;
            } catch (const std::exception&) {
                const auto removed = graphics->device->GetDeviceRemovedReason();
                if (SUCCEEDED(removed)) throw;
                ImGui_ImplDX11_Shutdown(); dxBackend = false;
                graphics = std::make_unique<visual_spc::D3DDevice>(window);
                ui.graphicsReset(*graphics);
                if (!ImGui_ImplDX11_Init(graphics->device.Get(), graphics->context.Get())) throw;
                dxBackend = true;
            }
        }
        CloseHandle(timer); player = nullptr;
        ImGui_ImplDX11_Shutdown(); dxBackend = false;
        ImGui_ImplWin32_Shutdown(); winBackend = false;
        ImGui::DestroyContext(); imgui = false;
    } catch (const std::exception& failure) {
        result = 1; player = nullptr;
        if (dxBackend) ImGui_ImplDX11_Shutdown();
        if (winBackend) ImGui_ImplWin32_Shutdown();
        if (imgui) ImGui::DestroyContext();
        MessageBoxW(window, visual_spc::wide(failure.what()).c_str(), L"Visual SPC Player", MB_ICONERROR);
    }
    if (window && IsWindow(window)) DestroyWindow(window);
    if (SUCCEEDED(com)) CoUninitialize();
    return result;
}
