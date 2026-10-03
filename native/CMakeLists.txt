cmake_minimum_required(VERSION 3.20)
project(SPCWebCore LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(spc_web_core STATIC
    web_api.cpp
    backend/software_spc_backend.cpp
    backend/spc_snapshot.c
    backend/spc_metadata.c
    vendor/snes_spc/SNES_SPC.cpp
    vendor/snes_spc/SNES_SPC_misc.cpp
    vendor/snes_spc/SNES_SPC_state.cpp
    vendor/snes_spc/SPC_DSP.cpp
)
target_include_directories(spc_web_core PUBLIC . backend vendor/snes_spc)
target_compile_definitions(spc_web_core PUBLIC SPC_ENABLE_ARAM_VISUALIZER=1)
target_compile_options(spc_web_core PRIVATE
    $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>)

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
    add_executable(spc_web_backend_test tests/backend_test.cpp)
    target_link_libraries(spc_web_backend_test PRIVATE spc_web_core)
    target_compile_options(spc_web_backend_test PRIVATE -Wall -Wextra -Werror -Wpedantic)
    add_test(NAME spc_web_backend COMMAND spc_web_backend_test)

    add_executable(spc_web_api_test tests/web_api_test.cpp)
    target_link_libraries(spc_web_api_test PRIVATE spc_web_core)
    target_compile_options(spc_web_api_test PRIVATE -Wall -Wextra -Werror -Wpedantic)
    add_test(NAME spc_web_api COMMAND spc_web_api_test)

    add_executable(spc_web_render tools/spc_render.cpp)
    target_link_libraries(spc_web_render PRIVATE spc_web_core)
    target_compile_options(spc_web_render PRIVATE -Wall -Wextra -Werror -Wpedantic)
endif()
