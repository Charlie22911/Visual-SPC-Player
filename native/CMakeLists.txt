cmake_minimum_required(VERSION 3.20)
project(SPCWebCore LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(spc_backend STATIC
    backend/software_spc_backend.cpp
    backend/spc_snapshot.c
    backend/spc_metadata.c
    vendor/snes_spc/SNES_SPC.cpp
    vendor/snes_spc/SNES_SPC_misc.cpp
    vendor/snes_spc/SNES_SPC_state.cpp
    vendor/snes_spc/SPC_DSP.cpp
)
set_target_properties(spc_backend PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(spc_backend PUBLIC . backend vendor/snes_spc)
target_compile_definitions(spc_backend PUBLIC SPC_ENABLE_ARAM_VISUALIZER=1)
if(NOT MSVC)
    # Legacy embedded C queue; desktop publication uses std::atomic SPSC.
    target_sources(spc_backend PRIVATE backend/spc_snapshot_queue.c)
endif()
if(MSVC)
    target_compile_options(spc_backend PRIVATE /utf-8 /fp:precise
        $<$<COMPILE_LANGUAGE:CXX>:/GR->)
else()
    target_compile_options(spc_backend PRIVATE
        $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>)
endif()
add_library(spc_web_core STATIC web_api.cpp state_packet.cpp)
target_link_libraries(spc_web_core PUBLIC spc_backend)

function(spc_test_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /utf-8 /Zc:__cplusplus)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Werror -Wpedantic)
    endif()
endfunction()

if(EMSCRIPTEN)
    add_executable(spc_core wasm_entry.cpp)
    target_link_libraries(spc_core PRIVATE spc_web_core)
    set_target_properties(spc_core PROPERTIES
        OUTPUT_NAME "spc_core"
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../public")
    target_link_options(spc_core PRIVATE
        --no-entry
        -sSTANDALONE_WASM=1
        -sALLOW_MEMORY_GROWTH=0
        -sINITIAL_MEMORY=67108864
        -sEXPORTED_FUNCTIONS=_web_spc_abi_version,_web_spc_init,_web_spc_prepare,_web_spc_commit_prepared,_web_spc_render,_web_spc_copy_aram,_web_spc_take_activity,_web_spc_copy_state,_web_spc_generated_frames,_web_spc_generation,_web_spc_dispose,_malloc,_free)
else()
    enable_testing()
    option(SPC_DESKTOP_STATIC_CORE "Link the desktop emulator into its caller" OFF)
    if(SPC_DESKTOP_STATIC_CORE)
        add_library(spc_native_core STATIC desktop_api.cpp state_packet.cpp)
        target_compile_definitions(spc_native_core PUBLIC SPC_NATIVE_STATIC)
    else()
        add_library(spc_native_core SHARED desktop_api.cpp state_packet.cpp)
        target_compile_definitions(spc_native_core PRIVATE SPC_NATIVE_BUILD)
    endif()
    target_link_libraries(spc_native_core PRIVATE spc_backend)
    target_include_directories(spc_native_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    set_target_properties(spc_native_core PROPERTIES OUTPUT_NAME "spc-native-core")
    spc_test_warnings(spc_native_core)
    find_package(Threads REQUIRED)
    add_executable(spc_desktop_api_test tests/desktop_api_test.cpp)
    target_link_libraries(spc_desktop_api_test PRIVATE spc_native_core spc_web_core Threads::Threads)
    spc_test_warnings(spc_desktop_api_test)
    add_test(NAME spc_desktop_api COMMAND spc_desktop_api_test)
    add_executable(spc_desktop_c_linkage_test tests/desktop_c_linkage_test.c)
    target_link_libraries(spc_desktop_c_linkage_test PRIVATE spc_native_core spc_backend)
    add_test(NAME spc_desktop_c_linkage COMMAND spc_desktop_c_linkage_test)

    add_executable(spc_web_backend_test tests/backend_test.cpp)
    target_link_libraries(spc_web_backend_test PRIVATE spc_web_core)
    spc_test_warnings(spc_web_backend_test)
    add_test(NAME spc_web_backend COMMAND spc_web_backend_test)

    add_executable(spc_web_api_test tests/web_api_test.cpp)
    target_link_libraries(spc_web_api_test PRIVATE spc_web_core)
    spc_test_warnings(spc_web_api_test)
    add_test(NAME spc_web_api COMMAND spc_web_api_test)

    add_executable(spc_web_render tools/spc_render.cpp)
    target_link_libraries(spc_web_render PRIVATE spc_web_core)
    spc_test_warnings(spc_web_render)
endif()
