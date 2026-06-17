#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/old/desmume/desmume/src"
OUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/public}"
export EM_CACHE="${EM_CACHE:-${ROOT_DIR}/.emscripten_cache}"
export EM_CONFIG="${EM_CONFIG:-${ROOT_DIR}/.emscripten_config}"

mkdir -p "${OUT_DIR}"
mkdir -p "${EM_CACHE}"
if [ ! -f "${EM_CONFIG}" ]; then
  cat > "${EM_CONFIG}" <<'CONFIG'
EMSCRIPTEN_ROOT = '/usr/share/emscripten'
LLVM_ROOT = '/usr/bin'
BINARYEN_ROOT = '/usr'
NODE_JS = '/usr/bin/node'
JAVA = 'java'
FROZEN_CACHE = False
CLOSURE_COMPILER = 'closure-compiler'
LLVM_ADD_VERSION = '15'
CLANG_ADD_VERSION = '15'
CONFIG
fi

mapfile -t CORE_CPP < <(
  find "${SRC_DIR}" -type f -name "*.cpp" \
    ! -path "*/frontend/*" \
    ! -path "*/gdbstub/*" \
    ! -path "*/utils/AsmJit/*" \
    ! -name "*_AVX*.cpp" \
    ! -name "*_SSE*.cpp" \
    ! -name "*_NEON.cpp" \
    ! -name "*_AltiVec.cpp" \
    ! -name "OGLRender*.cpp" \
    ! -name "ogl_collector.cpp" \
    ! -name "lua-engine.cpp" \
    ! -name "movie.cpp" \
    | sort
)

emcc "${ROOT_DIR}/webassembly/wasm-port.cpp" "${CORE_CPP[@]}" \
  -I"${SRC_DIR}" \
  -I"${SRC_DIR}/addons" \
  -I"${SRC_DIR}/utils" \
  -I"${SRC_DIR}/utils/tinyxml" \
  -I"${SRC_DIR}/utils/libfat" \
  -I"${SRC_DIR}/libretro-common/include" \
  -O3 \
  -std=c++17 \
  -DDESMUME_COCOA \
  -include algorithm \
  -include cassert \
  -sWASM=1 \
  -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=268435456 \
  -sMAXIMUM_MEMORY=2147483648 \
  -sMODULARIZE=1 \
  -sUSE_ZLIB=1 \
  -sEXPORT_NAME=CreateDesmumeModule \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_RUNTIME_METHODS='["FS","HEAPU8","HEAPU16","HEAPU32","HEAP32","ccall","cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
  -sEXPORTED_FUNCTIONS='["_main","_malloc","_free","_prepareRomBuffer","_loadROM","_reset","_runFrame","_runFrames","_fillAudioBuffer","_getSymbol","_setSampleRate","_savGetSize","_savGetPointer","_savUpdateChangeFlag","_stateGetSize","_stateGetPointer","_saveStateToBuffer","_loadStateFromBuffer","_zlibCompress","_zlibDecompress","_pauseEmu","_isPaused","_debuggerSetEnabled","_traceSetEnabled","_dbgGetReg","_dbgSetReg","_dbgRead8","_dbgRead16","_dbgRead32","_dbgWrite8","_dbgWrite16","_dbgWrite32","_dbgDumpMemory","_dbgSetExecBreakpoint","_dbgSetReadBreakpoint","_dbgSetWriteBreakpoint","_dbgStep","_dbgStepOver","_dbgGetStatusJson","_dbgDisassemble","_dbgStackTrace","_chtGetList","_chtAddItem","_utilStrLen","_emuSetOpt"]' \
  -o "${OUT_DIR}/desmume.js"

cp "${ROOT_DIR}/public/coi-serviceworker.js" "${OUT_DIR}/coi-serviceworker.js"
