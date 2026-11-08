#include "model/Library.h"
#include "test_check.h"
#include <chrono>
#include <cstring>
#include <fstream>
#include <thread>
using namespace visual_spc;
int main() {
    const auto root = std::filesystem::temp_directory_path() /
        ("visual-spc-fixture-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(root / L"Unicode-日本");
    std::vector<uint8_t> image(0x10180);
    const char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    image[0x25] = 0; image[0x26] = 2; image[0x300] = 0x2f; image[0x301] = 0xfe;
    const auto file = root / L"Unicode-日本" / L"Sample.SPC";
    { std::ofstream output(file, std::ios::binary); output.write(reinterpret_cast<const char*>(image.data()), image.size()); }
    bool complete = false; std::size_t count = 0; bool loaded = false;
    {
        Library worker;
        worker.scan(root);
        const auto loadId = worker.load(file);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (std::chrono::steady_clock::now() < deadline && (!complete || !loaded)) {
            ScanBatch batch;
            while (worker.popScan(batch)) { count += batch.files.size(); complete |= batch.complete; CHECK(batch.error.empty()); }
            LoadResult result;
            while (worker.popLoad(result)) {
                CHECK(result.id == loadId && result.instance && result.error.empty());
                CHECK(worker.retire(result.instance)); loaded = true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        worker.scan(root); worker.cancelScan();
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        ScanBatch stale; CHECK(!worker.popScan(stale));
        CHECK(worker.save(root / L"saved.json", "latest settings"));
        for (unsigned i = 0; i < 32; ++i) CHECK(worker.save(root / ("save-" + std::to_string(i) + ".json"), "latest settings"));
    }
    { std::ifstream saved(root / L"saved.json"); std::string text; std::getline(saved, text); CHECK(text == "latest settings"); }
    for (unsigned i = 0; i < 32; ++i) CHECK(std::filesystem::exists(root / ("save-" + std::to_string(i) + ".json")));
    std::filesystem::remove_all(root); // exact private fixture root created above
    CHECK(complete && count == 1 && loaded);
}
