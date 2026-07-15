#include <cheatSystem.h>
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zlib.h>

#include <sstream>
#include <string>
#include <algorithm>
#include <iomanip>
#include <map>
#include <vector>

#include "MMU.h"
#include "NDSSystem.h"
#include "SPU.h"
#include "armcpu.h"
#include "debug.h"
#include "frontend/modules/Disassembler.h"
#include "emufile.h"
#include "mc.h"
#include "rasterize.h"
#include "saves.h"
#include "utils/colorspacehandler/colorspacehandler.h"

CHEATSEXPORT *cheatsExport = NULL;

int emuLastError = 0;
EMUFILE_MEMORY *savFile = new EMUFILE_MEMORY();
static EMUFILE_MEMORY *stateFile = new EMUFILE_MEMORY();
static u8 *romBuffer = NULL;
static int romBufferCap = 0;
static int romLen = 0;
static bool romLoaded = false;
static s16 audioBuffer[16384 * 2];
static int samplesRead = 0;
static int samplesDesired = 0;
volatile bool execute = true;
static bool paused = true;
static bool debuggerEnabled = true;
static int debuggerSuspendDepth = 0;
static bool traceEnabled = false;
static bool tracePrivilegeCheck = true;
static u64 frameCounter = 0;
static bool specialBreakpoints[3] = {false, false, false};

static std::vector<u32> execBreakpoints[2];
static std::vector<u32> readBreakpoints[2];
static std::vector<u32> writeBreakpoints[2];
static std::string textScratch;

struct BreakStatus {
  bool hit;
  int proc;
  int kind;
  u32 address;
  int size;
  u32 value;
  u32 pc;
  u32 cpsr;
};

static BreakStatus lastBreak = {false, 0, -1, 0, 0, 0, 0, 0};

struct CallStackEntry {
  u32 caller;
  u32 callee;
  u32 sp;
  u32 cpsr;
  bool thumb;
  u32 id;
  bool synthetic;
  int kind;
  u32 target;
  u32 expected;
};

struct CallStackLane {
  u32 id;
  u32 lastSp;
  u32 nowPc;
  std::vector<CallStackEntry> frames;
};

static std::vector<CallStackLane> callStackLanes;
static size_t activeCallStackLane = 0;
static u32 nextCallStackLaneId = 1;
static std::map<u32, u32> callCountMap;
static const u32 CALL_STACK_SP_SWITCH_THRESHOLD = 0x2000;

struct TraceControlEvent {
  u32 pc;
  u32 target;
  u32 expected;
  u32 sp;
  u32 cpsr;
  int kind;
  int reg;
  bool mismatch;
};

static std::vector<TraceControlEvent> traceControlEvents;
static u32 tracePendingIrqResume[2] = {0, 0};

u32 dstFrameBuffer[2][256 * 192];

extern "C" unsigned cpu_features_get_core_amount(void) { return 1; }

static armcpu_t *cpuFor(int proc) { return proc == 0 ? &NDS_ARM9 : &NDS_ARM7; }

static bool hasBreakpoint(const std::vector<u32> &list, u32 addr) {
  return std::find(list.begin(), list.end(), addr) != list.end();
}

static bool removeBreakpoint(std::vector<u32> &list, u32 addr) {
  std::vector<u32>::iterator it = std::find(list.begin(), list.end(), addr);
  if (it == list.end()) return false;
  list.erase(it);
  return true;
}

static u32 absDiffU32(u32 a, u32 b) {
  return a > b ? a - b : b - a;
}

static size_t ensureCallStackLane() {
  if (callStackLanes.empty()) {
    callStackLanes.push_back({nextCallStackLaneId++, 0, 0, std::vector<CallStackEntry>()});
    activeCallStackLane = 0;
  }
  if (activeCallStackLane >= callStackLanes.size()) activeCallStackLane = 0;
  return activeCallStackLane;
}

static size_t selectCallStackLaneForSp(u32 sp) {
  ensureCallStackLane();
  size_t best = callStackLanes.size();
  u32 bestDiff = 0xffffffffU;
  for (size_t i = 0; i < callStackLanes.size(); i++) {
    CallStackLane &lane = callStackLanes[i];
    const u32 refSp = lane.frames.empty() ? lane.lastSp : lane.frames.back().sp;
    if (refSp == 0) {
      best = i;
      bestDiff = 0;
      break;
    }
    const u32 diff = absDiffU32(refSp, sp);
    if (diff <= CALL_STACK_SP_SWITCH_THRESHOLD && diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  if (best == callStackLanes.size()) {
    callStackLanes.push_back({nextCallStackLaneId++, sp, 0, std::vector<CallStackEntry>()});
    best = callStackLanes.size() - 1;
  }
  activeCallStackLane = best;
  return best;
}

static size_t createCallStackLane(u32 sp, u32 nowPc) {
  callStackLanes.push_back({nextCallStackLaneId++, sp, nowPc, std::vector<CallStackEntry>()});
  activeCallStackLane = callStackLanes.size() - 1;
  return activeCallStackLane;
}

static int topRealFrameIndex(const CallStackLane &lane) {
  for (size_t i = lane.frames.size(); i > 0; i--) {
    const size_t index = i - 1;
    if (!lane.frames[index].synthetic) return (int)index;
  }
  return -1;
}

static int findReturnCallStackLane(u32 target, int *frameIndex) {
  for (size_t i = 0; i < callStackLanes.size(); i++) {
    const CallStackLane &lane = callStackLanes[i];
    for (size_t j = lane.frames.size(); j > 0; j--) {
      const size_t index = j - 1;
      if (lane.frames[index].synthetic) continue;
      if ((lane.frames[index].caller & ~1U) == (target & ~1U)) {
        if (frameIndex) *frameIndex = (int)index;
        return (int)i;
      }
    }
  }
  return -1;
}

static void removeCallStackLane(size_t index) {
  if (index >= callStackLanes.size()) return;
  callStackLanes.erase(callStackLanes.begin() + index);
  if (callStackLanes.empty()) {
    activeCallStackLane = 0;
  } else if (activeCallStackLane > index) {
    activeCallStackLane--;
  } else if (activeCallStackLane >= callStackLanes.size()) {
    activeCallStackLane = callStackLanes.size() - 1;
  }
}

static size_t totalCallStackDepth() {
  size_t depth = 0;
  for (size_t i = 0; i < callStackLanes.size(); i++) depth += callStackLanes[i].frames.size();
  return depth;
}

static void compactCallStackLanes() {
  for (size_t i = callStackLanes.size(); i > 0; i--) {
    const size_t index = i - 1;
    if (index != activeCallStackLane && callStackLanes[index].frames.empty()) removeCallStackLane(index);
  }
  while (callStackLanes.size() > 128) {
    size_t drop = callStackLanes.size();
    for (size_t i = 0; i < callStackLanes.size(); i++) {
      if (i != activeCallStackLane && callStackLanes[i].frames.empty()) {
        drop = i;
        break;
      }
    }
    if (drop == callStackLanes.size()) {
      for (size_t i = 0; i < callStackLanes.size(); i++) {
        if (i != activeCallStackLane) {
          drop = i;
          break;
        }
      }
    }
    if (drop == callStackLanes.size()) break;
    removeCallStackLane(drop);
  }
}

static int findSyntheticCallStackLane(int kind, u32 expected, int *frameIndex) {
  for (size_t i = 0; i < callStackLanes.size(); i++) {
    const CallStackLane &lane = callStackLanes[i];
    for (size_t j = lane.frames.size(); j > 0; j--) {
      const size_t index = j - 1;
      const CallStackEntry &entry = lane.frames[index];
      if (!entry.synthetic || entry.kind != kind) continue;
      if ((entry.expected & ~1U) == (expected & ~1U)) {
        if (frameIndex) *frameIndex = (int)index;
        return (int)i;
      }
    }
  }
  return -1;
}

static int normalizeFrameLimit(int limit) {
  if (limit < 1) limit = 128;
  if (limit > 1024) limit = 1024;
  return limit;
}

static void restoreBreakpoint(std::vector<u32> &list, u32 addr, bool removed) {
  if (removed && !hasBreakpoint(list, addr)) list.push_back(addr);
}

static void recordBreak(int proc, int kind, u32 address, int size, u32 value) {
  armcpu_t *cpu = cpuFor(proc);
  lastBreak = {true, proc, kind, address, size, value, cpu->instruct_adr, cpu->CPSR.val};
  paused = true;
  execute = false;
}

extern "C" int wasmDebuggerShouldBreak(int proc, int kind, u32 address, int size, u32 value) {
  if (!debuggerEnabled || debuggerSuspendDepth > 0) return 0;
  const int idx = proc == 0 ? 0 : 1;
  bool hit = false;
  if (kind == 0) hit = hasBreakpoint(execBreakpoints[idx], address);
  else if (kind == 1) hit = hasBreakpoint(readBreakpoints[idx], address);
  else if (kind == 2) hit = hasBreakpoint(writeBreakpoints[idx], address);
  else if (kind >= 3 && kind <= 5) hit = specialBreakpoints[kind - 3];
  if (!hit) return 0;
  recordBreak(idx, kind, address, size, value);
  return 1;
}

extern "C" void wasmEnterFunctionHook(int proc) {
  if (!traceEnabled || proc != 0) return;
  armcpu_t *cpu = cpuFor(proc);
  if (tracePrivilegeCheck && ((cpu->CPSR.val & 0x1f) == IRQ)) return;
  const u32 sp = cpu->R[13];
  CallStackLane &lane = callStackLanes[selectCallStackLaneForSp(sp)];
  while (!lane.frames.empty() && lane.frames.back().sp <= sp) lane.frames.pop_back();
  lane.lastSp = sp;
  lane.nowPc = cpu->instruct_adr;
  const u32 callee = cpu->instruct_adr;
  const int realIndex = topRealFrameIndex(lane);
  if (realIndex >= 0) {
    CallStackEntry &entry = lane.frames[(size_t)realIndex];
    if ((entry.caller & ~1U) == (cpu->R[14] & ~1U) && (entry.callee & ~1U) == (callee & ~1U)) {
      entry.sp = sp;
      entry.cpsr = cpu->CPSR.val;
      entry.thumb = cpu->CPSR.bits.T != 0;
      return;
    }
  }
  const u32 id = callCountMap[callee]++;
  lane.frames.push_back({cpu->R[14], callee, sp, cpu->CPSR.val, cpu->CPSR.bits.T != 0, id, false, 0, 0, 0});
  if (lane.frames.size() > 1024) lane.frames.erase(lane.frames.begin(), lane.frames.begin() + (lane.frames.size() - 1024));
}

extern "C" void wasmCallFunctionHook(int proc, u32 target, u32 returnAddress) {
  if (!traceEnabled || proc != 0) return;
  armcpu_t *cpu = cpuFor(proc);
  if (tracePrivilegeCheck && ((cpu->CPSR.val & 0x1f) == IRQ)) return;
  const u32 sp = cpu->R[13];
  CallStackLane &lane = callStackLanes[selectCallStackLaneForSp(sp)];
  lane.lastSp = sp;
  lane.nowPc = target;
  const int realIndex = topRealFrameIndex(lane);
  if (realIndex >= 0) {
    const CallStackEntry &entry = lane.frames[(size_t)realIndex];
    if ((entry.caller & ~1U) == (returnAddress & ~1U) && (entry.callee & ~1U) == (target & ~1U)) return;
  }
  const u32 id = callCountMap[target]++;
  lane.frames.push_back({returnAddress, target, sp, cpu->CPSR.val, cpu->CPSR.bits.T != 0, id, false, 0, 0, 0});
  if (lane.frames.size() > 1024) lane.frames.erase(lane.frames.begin(), lane.frames.begin() + (lane.frames.size() - 1024));
}

extern "C" void wasmTraceControlFlowHook(int proc, int kind, int reg, u32 target) {
  if (!traceEnabled || proc != 0) return;
  armcpu_t *cpu = cpuFor(proc);
  if (tracePendingIrqResume[proc] != 0 && ((tracePendingIrqResume[proc] & ~1U) == (target & ~1U)) && (kind == 4 || kind == 6)) {
    int irqFrameIndex = -1;
    const int irqLaneIndex = findSyntheticCallStackLane(8, target, &irqFrameIndex);
    if (irqLaneIndex >= 0 && irqFrameIndex >= 0) {
      CallStackLane &irqLane = callStackLanes[(size_t)irqLaneIndex];
      irqLane.frames.erase(irqLane.frames.begin() + irqFrameIndex, irqLane.frames.end());
      if (irqLane.frames.empty()) removeCallStackLane((size_t)irqLaneIndex);
    }
    tracePendingIrqResume[proc] = 0;
    CallStackLane &lane = callStackLanes[selectCallStackLaneForSp(cpu->R[13])];
    lane.lastSp = cpu->R[13];
    lane.nowPc = target;
    compactCallStackLanes();
    if (!tracePrivilegeCheck) {
      traceControlEvents.push_back({cpu->instruct_adr, target, target, cpu->R[13], cpu->CPSR.val, 9, 15, false});
      if (traceControlEvents.size() > 128) traceControlEvents.erase(traceControlEvents.begin(), traceControlEvents.begin() + (traceControlEvents.size() - 128));
    }
    return;
  }
  if (tracePrivilegeCheck && ((cpu->CPSR.val & 0x1f) == IRQ)) return;
  int returnFrameIndex = -1;
  int laneIndex = findReturnCallStackLane(target, &returnFrameIndex);
  if (laneIndex < 0) laneIndex = (int)selectCallStackLaneForSp(cpu->R[13]);
  CallStackLane &lane = callStackLanes[(size_t)laneIndex];
  activeCallStackLane = (size_t)laneIndex;
  const int realIndex = returnFrameIndex >= 0 ? returnFrameIndex : topRealFrameIndex(lane);
  const u32 expected = realIndex < 0 ? 0 : lane.frames[(size_t)realIndex].caller;
  const bool mismatch = expected != 0 && ((target & ~1U) != (expected & ~1U));
  const bool alwaysRecord = kind >= 3 || reg != 14 || expected == 0;
  const bool poppedFrame = expected != 0 && !mismatch;
  if (poppedFrame) lane.frames.erase(lane.frames.begin() + realIndex, lane.frames.end());
  lane.lastSp = cpu->R[13];
  lane.nowPc = target;
  if (mismatch) {
    lane.frames.push_back({cpu->instruct_adr, target, cpu->R[13], cpu->CPSR.val, cpu->CPSR.bits.T != 0, 0, true, kind, target, expected});
    if (lane.frames.size() > 1024) lane.frames.erase(lane.frames.begin(), lane.frames.begin() + (lane.frames.size() - 1024));
  }
  if (poppedFrame && lane.frames.empty()) removeCallStackLane((size_t)laneIndex);
  compactCallStackLanes();
  if (!alwaysRecord && !mismatch) return;
  traceControlEvents.push_back({cpu->instruct_adr, target, expected, cpu->R[13], cpu->CPSR.val, kind, reg, mismatch});
  if (traceControlEvents.size() > 128) traceControlEvents.erase(traceControlEvents.begin(), traceControlEvents.begin() + (traceControlEvents.size() - 128));
}

extern "C" void wasmTraceIrqEnterHook(int proc, u32 sourcePc, u32 vectorPc, u32 resumePc, u32 irqSp, u32 irqCpsr) {
  if (!traceEnabled || proc != 0) return;
  tracePendingIrqResume[proc] = resumePc;
  if (tracePrivilegeCheck) return;
  int frameIndex = -1;
  int laneIndex = findSyntheticCallStackLane(8, resumePc, &frameIndex);
  if (laneIndex < 0) laneIndex = (int)createCallStackLane(irqSp, vectorPc);
  CallStackLane &lane = callStackLanes[(size_t)laneIndex];
  activeCallStackLane = (size_t)laneIndex;
  lane.lastSp = irqSp;
  lane.nowPc = vectorPc;
  if (frameIndex >= 0) {
    CallStackEntry &entry = lane.frames[(size_t)frameIndex];
    entry.caller = sourcePc;
    entry.callee = vectorPc;
    entry.sp = irqSp;
    entry.cpsr = irqCpsr;
    entry.target = vectorPc;
    entry.expected = resumePc;
  } else {
    lane.frames.push_back({sourcePc, vectorPc, irqSp, irqCpsr, false, 0, true, 8, vectorPc, resumePc});
    if (lane.frames.size() > 1024) lane.frames.erase(lane.frames.begin(), lane.frames.begin() + (lane.frames.size() - 1024));
  }
  traceControlEvents.push_back({sourcePc, vectorPc, resumePc, irqSp, irqCpsr, 8, 15, true});
  if (traceControlEvents.size() > 128) traceControlEvents.erase(traceControlEvents.begin(), traceControlEvents.begin() + (traceControlEvents.size() - 128));
  compactCallStackLanes();
}

static void gpu_screen_to_rgb(u32 *dst) {
  ColorspaceConvertBuffer555xTo8888Opaque<false, false, BESwapNone>(
      (const uint16_t *)GPU->GetDisplayInfo().masterNativeBuffer16, dst,
      GPU_FRAMEBUFFER_NATIVE_WIDTH * GPU_FRAMEBUFFER_NATIVE_HEIGHT * 2);
}

void SNDWasmUpdateAudio(s16 *buffer, u32 num_samples) {
  samplesRead = num_samples;
  memcpy(audioBuffer, buffer, sizeof(s16) * num_samples * 2);
}
u32 SNDWasmGetAudioSpace() { return samplesDesired; }
int SNDWasmInit(int buffersize) { return 0; }
void SNDWasmDeInit() {}
void SNDWasmMuteAudio() {}
void SNDWasmUnMuteAudio() {}
void SNDWasmSetVolume(int volume) {}
void SNDWasmClearBuffer() {}
void SNDWasmFetchSamples(s16 *sampleBuffer, size_t sampleCount,
                         ESynchMode synchMode,
                         ISynchronizingAudioBuffer *theSynchronizer) {
  if (synchMode == ESynchMode_Synchronous) {
    theSynchronizer->enqueue_samples(sampleBuffer, sampleCount);
  }
}

SoundInterface_struct SndWasm = {1,
                                 "Wasm Sound Interface",
                                 SNDWasmInit,
                                 SNDWasmDeInit,
                                 SNDWasmUpdateAudio,
                                 SNDWasmGetAudioSpace,
                                 SNDWasmMuteAudio,
                                 SNDWasmUnMuteAudio,
                                 SNDWasmSetVolume,
                                 SNDWasmClearBuffer,
                                 NULL,
                                 NULL};

SoundInterface_struct *SNDCoreList[] = {&SNDDummy, &SndWasm, NULL};
GPU3DInterface *core3DList[] = {&gpu3DNull, &gpu3DRasterize, NULL};

int main() {
  srand(time(NULL));
  NDS_Init();
  SPU_ChangeSoundCore(1, 16384);
  GPU->Change3DRendererByID(RENDERID_SOFTRASTERIZER);
  cheatsExport = new CHEATSEXPORT();
  printf("desmume wasm ready.\n");
  EM_ASM({ if (typeof wasmReady === "function") wasmReady(); });
  return 0;
}

extern "C" {

void setSampleRate(int r) {
  (void)r;
}

void *prepareRomBuffer(int rl) {
  romLen = rl;
  if (romLen > romBufferCap) {
    romBuffer = (u8 *)realloc((void *)romBuffer, romLen);
    romBufferCap = romLen;
  }
  return romBuffer;
}

void *getSymbol(int id) {
  if (id == 4) return dstFrameBuffer;
  if (id == 6) return audioBuffer;
  if (id == 7) return MMU.MAIN_MEM;
  return 0;
}
// wasm-port.cpp

int reset() {
  if (!romLoaded || romLen <= 0) return -1;
  paused = true;
  execute = false;
  NDS_Reset();
  frameCounter = 0;
  lastBreak.hit = false;
  return 0;
}

int loadROM(int len) {
  romLen = len;
  const bool hadRom = romLoaded;
  romLoaded = false;
  paused = true;
  emuLastError = -2;
  if (hadRom) {
    NDS_FreeROM();
  }
  // ★ ここで savFile を新しいインスタンスに差し替える
  // BackupDevice のデストラクタが旧 savFile を delete するので、
  // NDS_LoadROM の前に新しいポインタを用意しておく
  savFile = new EMUFILE_MEMORY();

  SPU_SetSynchMode(ESynchMode_Synchronous, ESynchMethod_N);
  SPU_SetVolume(35);

  if (!NDS_LoadROM("rom.nds")) {
    return emuLastError;
  }
  romLoaded = true;
  paused = false;
  execute = true;
  frameCounter = 0;
  lastBreak.hit = false;
  return 0;
}

int isRomLoaded() { return romLoaded ? 1 : 0; }

int runFrame(int shouldDraw, u32 keys, int touched, u32 touchX, u32 touchY) {
  if (paused || !romLoaded) return 0;
  const u32 startPc9 = NDS_ARM9.instruct_adr;
  const u32 startPc7 = NDS_ARM7.instruct_adr;
  if (!shouldDraw) NDS_SkipNextFrame();
  if (touched) {
    NDS_setTouchPos(touchX, touchY);
  } else {
    NDS_releaseTouch();
  }
  NDS_setPad(keys & (1 << 4), keys & (1 << 5), keys & (1 << 7), keys & (1 << 6),
             keys & (1 << 2), keys & (1 << 3), keys & (1 << 1), keys & (1 << 0),
             keys & (1 << 11), keys & (1 << 10), keys & (1 << 9),
             keys & (1 << 8), keys & (1 << 12), keys & (1 << 13));
  NDS_beginProcessingInput();
  NDS_endProcessingInput();
  NDS_exec<false>();
  const bool retrappedSameExecBreakpoint = lastBreak.hit && lastBreak.kind == 0 &&
    ((lastBreak.proc == 0 && lastBreak.address == startPc9 && lastBreak.pc == startPc9) ||
     (lastBreak.proc == 1 && lastBreak.address == startPc7 && lastBreak.pc == startPc7));
  if (!retrappedSameExecBreakpoint) frameCounter++;
  if (shouldDraw) gpu_screen_to_rgb((u32 *)dstFrameBuffer);
  return paused ? 1 : 0;
}

int captureFrameBuffer() {
  if (!romLoaded) return -1;
  gpu_screen_to_rgb((u32 *)dstFrameBuffer);
  return 0;
}

extern "C" void wasmDebuggerSetInternalSuspend(int enabled) {
  if (enabled) debuggerSuspendDepth++;
  else if (debuggerSuspendDepth > 0) debuggerSuspendDepth--;
}

int runFrames(int count, int shouldDraw, u32 keys) {
  if (count < 0) return -1;
  int ran = 0;
  for (int i = 0; i < count; i++) {
    ran++;
    if (runFrame(shouldDraw && i == count - 1, keys, 0, 0, 0) != 0) break;
  }
  return ran;
}

int fillAudioBuffer(int bufLenToFill) {
  samplesDesired = bufLenToFill;
  samplesRead = 0;
  SPU_Emulate_user();
  return samplesRead;
}

int savGetSize() { return savFile->size(); }

void *savGetPointer(int desiredSize) {
  // truncate() はバッファを再アロケートし BackupDevice 内部の状態と食い違うため使用禁止。
  // セーブデータの書き込みは必ず savImportFromFile() 経由で行うこと。
  if (desiredSize > savFile->size()) {
    return NULL;
  }
  return savFile->buf();
}

int savUpdateChangeFlag() {
  return 0;
}

int savImportFromFile(int forceSize) {
  bool ok = MMU_new.backupDevice.importData("import.sav", forceSize > 0 ? (u32)forceSize : 0);
  return ok ? 0 : -1;
}

int savExportToFile() {
  bool ok = MMU_new.backupDevice.exportData("export.sav");
  return ok ? 0 : -1;
}

int stateGetSize() { return stateFile->size(); }

void *stateGetPointer(int desiredSize) {
  if (desiredSize > 0) {
    stateFile->truncate(desiredSize);
    stateFile->fseek(0, SEEK_SET);
  }
  return stateFile->buf();
}

int saveStateToBuffer() {
  stateFile->truncate(0);
  stateFile->fseek(0, SEEK_SET);
  savestate_save(*stateFile, 0);
  return stateFile->size();
}

int loadStateFromBuffer(int size) {
  if (size < 0) return -1;
  if (size > 0 && stateFile->size() != size) return -2;
  stateFile->fseek(0, SEEK_SET);
  return savestate_load(*stateFile) ? 0 : -1;
}

int loadStateFromFile() {
  FILE *fp = fopen("import.dst", "rb");
  if (!fp) return -1;
  if (fseek(fp, 0, SEEK_END) != 0) {
    fclose(fp);
    return -2;
  }
  long size = ftell(fp);
  if (size <= 0) {
    fclose(fp);
    return -3;
  }
  if (fseek(fp, 0, SEEK_SET) != 0) {
    fclose(fp);
    return -4;
  }
  std::vector<u8> bytes((size_t)size);
  size_t read = fread(bytes.data(), 1, bytes.size(), fp);
  fclose(fp);
  if (read != bytes.size()) return -5;
  EMUFILE_MEMORY file(&bytes);
  return savestate_load(file) ? 0 : -1;
}

int zlibCompress(u8 *srcBuffer, size_t srcLen, u8 *dstBuffer, size_t dstLen,
                 int level) {
  int ret = compress2(dstBuffer, &dstLen, srcBuffer, srcLen, level);
  return ret == Z_OK ? (int)dstLen : -1;
}

int zlibDecompress(u8 *srcBuffer, size_t srcLen, u8 *dstBuffer, size_t dstLen) {
  int ret = uncompress(dstBuffer, &dstLen, srcBuffer, srcLen);
  return ret == Z_OK ? (int)dstLen : -1;
}

int pauseEmu(int value) {
  paused = value != 0;
  execute = !paused;
  return paused ? 1 : 0;
}

int isPaused() { return paused ? 1 : 0; }

int debuggerSetEnabled(int value) {
  debuggerEnabled = value != 0;
  return debuggerEnabled ? 1 : 0;
}

int traceSetEnabled(int value) {
  traceEnabled = value != 0;
  if (!traceEnabled) {
    callStackLanes.clear();
    activeCallStackLane = 0;
    nextCallStackLaneId = 1;
    callCountMap.clear();
    traceControlEvents.clear();
    tracePendingIrqResume[0] = 0;
    tracePendingIrqResume[1] = 0;
  }
  return traceEnabled ? 1 : 0;
}

int traceSetPrivilegeCheck(int value) {
  tracePrivilegeCheck = value != 0;
  return tracePrivilegeCheck ? 1 : 0;
}

int traceGetDepth() {
  if (callStackLanes.empty() || activeCallStackLane >= callStackLanes.size()) return 0;
  return (int)callStackLanes[activeCallStackLane].frames.size();
}

u32 dbgGetReg(int proc, int reg) {
  armcpu_t *cpu = cpuFor(proc);
  if (reg >= 0 && reg < 16) return cpu->R[reg];
  if (reg == 16) return cpu->CPSR.val;
  if (reg == 17) return cpu->SPSR.val;
  if (reg == 18) return cpu->instruct_adr;
  if (reg == 19) return cpu->next_instruction;
  return 0;
}

int dbgSetReg(int proc, int reg, u32 value) {
  armcpu_t *cpu = cpuFor(proc);
  if (reg >= 0 && reg < 16) {
    cpu->R[reg] = value;
    return 0;
  }
  if (reg == 16) {
    cpu->CPSR.val = value;
    armcpu_changeCPSR();
    return 0;
  }
  return -1;
}

u32 dbgRead8(int proc, u32 addr) { return _MMU_read08(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr); }
u32 dbgRead16(int proc, u32 addr) { return _MMU_read16(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr); }
u32 dbgRead32(int proc, u32 addr) { return _MMU_read32(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr); }

int dbgWrite8(int proc, u32 addr, u32 value) {
  _MMU_write08(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr, value & 0xff);
  return 0;
}
int dbgWrite16(int proc, u32 addr, u32 value) {
  _MMU_write16(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr, value & 0xffff);
  return 0;
}
int dbgWrite32(int proc, u32 addr, u32 value) {
  _MMU_write32(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, MMU_AT_DEBUG, addr, value);
  return 0;
}

void *dbgDumpMemory(int proc, u32 addr, int len) {
  static std::vector<u8> dump;
  if (len < 0) len = 0;
  if (len > 16 * 1024 * 1024) len = 16 * 1024 * 1024;
  dump.resize(len);
  for (int i = 0; i < len; i++) dump[i] = (u8)dbgRead8(proc, addr + i);
  return dump.data();
}

static int setBreakpoint(std::vector<u32> &list, u32 addr, int enabled) {
  for (size_t i = 0; i < list.size(); i++) {
    if (list[i] == addr) {
      if (!enabled) list.erase(list.begin() + i);
      return 0;
    }
  }
  if (enabled) list.push_back(addr);
  return 0;
}

static int execBreakpointIndex(int proc) { return proc == 0 ? 0 : 1; }

static int stepInstructionInternal(int proc, bool bypassCurrentExecBreakpoint) {
  armcpu_t *cpu = cpuFor(proc);
  std::vector<u32> &execList = execBreakpoints[execBreakpointIndex(proc)];
  const u32 startPc = cpu->instruct_adr;
  const bool removed = bypassCurrentExecBreakpoint && removeBreakpoint(execList, startPc);
  if (proc == 0) armcpu_exec<0>();
  else armcpu_exec<1>();
  restoreBreakpoint(execList, startPc, removed);
  return paused ? 1 : 0;
}

int dbgSetExecBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(execBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}
int dbgSetReadBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(readBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}
int dbgSetWriteBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(writeBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}

int dbgSetSpecialBreakpoint(int kind, int enabled) {
  if (kind < 3 || kind > 5) return -1;
  specialBreakpoints[kind - 3] = enabled != 0;
  return 0;
}

int dbgClearBreakStatus() {
  lastBreak.hit = false;
  return 0;
}

int dbgClearAllBreakpoints() {
  for (int i = 0; i < 2; i++) {
    execBreakpoints[i].clear();
    readBreakpoints[i].clear();
    writeBreakpoints[i].clear();
  }
  return 0;
}

int dbgStep(int proc, int count) {
  if (count < 1) count = 1;
  bool wasPaused = paused;
  lastBreak.hit = false;
  paused = false;
  int executed = 0;
  for (int i = 0; i < count; i++) {
    executed++;
    stepInstructionInternal(proc, i == 0);
    if (paused) {
      break;
    }
  }
  paused = paused || wasPaused;
  return executed;
}

int dbgStepOver(int proc) {
  armcpu_t *cpu = cpuFor(proc);
  const u32 next = cpu->instruct_adr + (cpu->CPSR.bits.T ? 2 : 4);
  bool wasPaused = paused;
  lastBreak.hit = false;
  paused = false;
  int count = 0;
  stepInstructionInternal(proc, true);
  count++;
  while (!paused && cpu->instruct_adr != next && count < 500000) {
    if (proc == 0) armcpu_exec<0>();
    else armcpu_exec<1>();
    count++;
  }
  paused = paused || wasPaused;
  return count;
}

const char *dbgGetStatusJson() {
  std::ostringstream os;
  os << "{\"paused\":" << (paused ? "true" : "false")
     << ",\"debuggerEnabled\":" << (debuggerEnabled ? "true" : "false")
     << ",\"traceEnabled\":" << (traceEnabled ? "true" : "false")
     << ",\"frame\":" << frameCounter
     << ",\"arm9\":{\"pc\":" << NDS_ARM9.instruct_adr << ",\"cpsr\":" << NDS_ARM9.CPSR.val << "}"
     << ",\"arm7\":{\"pc\":" << NDS_ARM7.instruct_adr << ",\"cpsr\":" << NDS_ARM7.CPSR.val << "}"
     << ",\"lastBreak\":{\"hit\":" << (lastBreak.hit ? "true" : "false")
     << ",\"cpu\":\"" << (lastBreak.proc == 0 ? "arm9" : "arm7") << "\""
     << ",\"kind\":" << lastBreak.kind
     << ",\"address\":" << lastBreak.address
     << ",\"size\":" << lastBreak.size
     << ",\"value\":" << lastBreak.value
     << ",\"pc\":" << lastBreak.pc
     << ",\"cpsr\":" << lastBreak.cpsr << "}"
     << ",\"specialBreakpoints\":{\"dataAbort\":" << (specialBreakpoints[0] ? "true" : "false")
     << ",\"prefetchAbort\":" << (specialBreakpoints[1] ? "true" : "false")
     << ",\"undefinedInstruction\":" << (specialBreakpoints[2] ? "true" : "false") << "}}";
  textScratch = os.str();
  return textScratch.c_str();
}

const char *dbgDisassemble(int proc, u32 addr, int count, int mode) {
  if (count < 1) count = 1;
  if (count > 256) count = 256;
  std::ostringstream os;
  u32 pc = cpuFor(proc)->instruct_adr;
  for (int i = 0; i < count; i++) {
    bool thumb = mode == 1 || (mode == 0 && (cpuFor(proc)->CPSR.bits.T != 0));
    u32 at = addr + (thumb ? i * 2 : i * 4);
    char txt[128] = {0};
    if (thumb) {
      u32 op = dbgRead16(proc, at);
      des_thumb_instructions_set[(op & 0xffff) >> 6](at, op, txt);
      os << (at == pc ? "=> " : "   ") << std::hex << at << ": " << op << "  " << txt << "\n";
    } else {
      u32 op = dbgRead32(proc, at);
      des_arm_instructions_set[INSTRUCTION_INDEX(op)](at, op, txt);
      os << (at == pc ? "=> " : "   ") << std::hex << at << ": " << op << "  " << txt << "\n";
    }
  }
  textScratch = os.str();
  return textScratch.c_str();
}

const char *dbgDisassembleOpcode(u32 addr, u32 opcode, int mode) {
  char txt[128] = {0};
  if (mode == 1) {
    des_thumb_instructions_set[(opcode & 0xffff) >> 6](addr, opcode & 0xffff, txt);
  } else {
    des_arm_instructions_set[INSTRUCTION_INDEX(opcode)](addr, opcode, txt);
  }
  textScratch = txt;
  return textScratch.c_str();
}

const char *utilBinaryFloat(int bits, u32 low, u32 high, double value, int encode) {
  std::ostringstream os;
  os << std::setprecision(17);
  if (bits == 32) {
    u32 raw = low;
    float f = 0.0f;
    if (encode) {
      f = (float)value;
      memcpy(&raw, &f, sizeof(raw));
    } else {
      memcpy(&f, &raw, sizeof(f));
    }
    os << "{\"ok\":true,\"bits\":32,\"hex\":\"0x" << std::hex << std::setw(8) << std::setfill('0') << raw
       << std::dec << "\",\"value\":" << (double)f
       << ",\"bytesLE\":[" << (raw & 0xff) << "," << ((raw >> 8) & 0xff) << "," << ((raw >> 16) & 0xff) << "," << ((raw >> 24) & 0xff) << "]"
       << ",\"bytesBE\":[" << ((raw >> 24) & 0xff) << "," << ((raw >> 16) & 0xff) << "," << ((raw >> 8) & 0xff) << "," << (raw & 0xff) << "]}";
  } else if (bits == 64) {
    u64 raw = ((u64)high << 32) | low;
    double d = 0.0;
    if (encode) {
      d = value;
      memcpy(&raw, &d, sizeof(raw));
    } else {
      memcpy(&d, &raw, sizeof(d));
    }
    u32 outLow = (u32)(raw & 0xffffffffULL);
    u32 outHigh = (u32)(raw >> 32);
    os << "{\"ok\":true,\"bits\":64,\"hex\":\"0x" << std::hex << std::setw(8) << std::setfill('0') << outHigh
       << std::setw(8) << outLow << std::dec << "\",\"low\":\"0x" << std::hex << std::setw(8) << outLow
       << "\",\"high\":\"0x" << std::setw(8) << outHigh << std::dec << "\",\"value\":" << d << ",\"bytesLE\":[";
    for (int i = 0; i < 8; i++) {
      if (i) os << ",";
      os << ((raw >> (i * 8)) & 0xff);
    }
    os << "],\"bytesBE\":[";
    for (int i = 7; i >= 0; i--) {
      if (i != 7) os << ",";
      os << ((raw >> (i * 8)) & 0xff);
    }
    os << "]}";
  } else {
    os << "{\"ok\":false,\"error\":\"bits must be 32 or 64\"}";
  }
  textScratch = os.str();
  return textScratch.c_str();
}

const char *dbgStackTrace(int proc, int words) {
  if (words < 1) words = 16;
  if (words > 256) words = 256;
  u32 sp = dbgGetReg(proc, 13);
  std::ostringstream os;
  os << "trace=" << (traceEnabled ? "on" : "off")
     << " privilegeCheck=" << (tracePrivilegeCheck ? "on" : "off")
     << " sp=0x" << std::hex << sp << "\n";
  os << "return   callee(id)      caller      sp  newest first\n";
  if (!callStackLanes.empty() && activeCallStackLane < callStackLanes.size()) {
    const std::vector<CallStackEntry> &frames = callStackLanes[activeCallStackLane].frames;
    for (size_t offset = 0; offset < frames.size(); offset++) {
      const CallStackEntry &entry = frames[frames.size() - 1 - offset];
      const u32 caller = ((entry.caller & ~1U) - 4) & 0xffffffffU;
      os << "0x" << std::hex << entry.caller << "  0x" << entry.callee << "(" << std::dec << entry.id << ")"
         << " caller=0x" << std::hex << caller
         << (entry.thumb ? " T" : " A") << "  0x" << std::hex << entry.sp << "\n";
    }
  }
  os << "-- stack words --\n";
  for (int i = 0; i < words; i++) {
    u32 at = sp + i * 4;
    u32 value = dbgRead32(proc, at);
    os << "0x" << std::hex << at << ": 0x" << value;
    if ((value & 0x0f000000) == 0x02000000 || (value & 0x0f000000) == 0x00000000) {
      u32 target = value & ~1U;
      char txt[128] = {0};
      if (value & 1) {
        u32 op = dbgRead16(proc, target);
        des_thumb_instructions_set[(op & 0xffff) >> 6](target, op, txt);
      } else {
        u32 op = dbgRead32(proc, target);
        des_arm_instructions_set[INSTRUCTION_INDEX(op)](target, op, txt);
      }
      os << "  possible_lr 0x" << target << "  " << txt;
    }
    os << "\n";
  }
  textScratch = os.str();
  return textScratch.c_str();
}

static void writeCallStackFrameJson(std::ostringstream &os, const CallStackEntry &entry) {
  const u32 caller = entry.synthetic ? entry.caller : (((entry.caller & ~1U) - 4) & 0xffffffffU);
  os << "{\"caller\":" << caller
     << ",\"returnAddress\":" << entry.caller
     << ",\"callee\":" << entry.callee
     << ",\"sp\":" << entry.sp
     << ",\"cpsr\":" << entry.cpsr
     << ",\"thumb\":" << (entry.thumb ? "true" : "false")
     << ",\"id\":" << entry.id;
  if (entry.synthetic) {
    os << ",\"synthetic\":true"
       << ",\"kind\":" << entry.kind
       << ",\"target\":" << entry.target
       << ",\"expected\":" << entry.expected;
  }
  os << "}";
}

static void writeCallStackFramesJson(std::ostringstream &os, const std::vector<CallStackEntry> &frames, int limit) {
  const int count = std::min((int)frames.size(), limit);
  for (int offset = 0; offset < count; offset++) {
    const CallStackEntry &entry = frames[frames.size() - 1 - offset];
    if (offset) os << ",";
    writeCallStackFrameJson(os, entry);
  }
}

const char *dbgCallStackJsonLimit(int limit) {
  limit = normalizeFrameLimit(limit);
  compactCallStackLanes();
  if (callStackLanes.empty()) {
    std::ostringstream empty;
    empty << "{\"enabled\":" << (traceEnabled ? "true" : "false")
          << ",\"privilegeCheck\":" << (tracePrivilegeCheck ? "true" : "false")
          << ",\"depth\":0,\"totalDepth\":0,\"activeStackId\":0,\"nowPc\":0,\"limit\":" << limit
          << ",\"frames\":[],\"stacks\":[],\"controlFlow\":[]}";
    textScratch = empty.str();
    return textScratch.c_str();
  }
  const size_t active = ensureCallStackLane();
  CallStackLane &activeLane = callStackLanes[active];
  std::ostringstream os;
  os << "{\"enabled\":" << (traceEnabled ? "true" : "false")
     << ",\"privilegeCheck\":" << (tracePrivilegeCheck ? "true" : "false")
     << ",\"depth\":" << activeLane.frames.size()
     << ",\"totalDepth\":" << totalCallStackDepth()
     << ",\"activeStackId\":" << activeLane.id
     << ",\"nowPc\":" << activeLane.nowPc
     << ",\"limit\":" << limit
     << ",\"frames\":[";
  writeCallStackFramesJson(os, activeLane.frames, limit);
  os << "],\"stacks\":[";
  for (size_t i = 0; i < callStackLanes.size(); i++) {
    const CallStackLane &lane = callStackLanes[i];
    if (i) os << ",";
    os << "{\"id\":" << lane.id
       << ",\"active\":" << (i == active ? "true" : "false")
       << ",\"depth\":" << lane.frames.size()
       << ",\"sp\":" << lane.lastSp
       << ",\"nowPc\":" << lane.nowPc
       << ",\"frames\":[";
    writeCallStackFramesJson(os, lane.frames, limit);
    os << "]}";
  }
  os << "],\"controlFlow\":[";
  for (size_t i = 0; i < traceControlEvents.size(); i++) {
    const TraceControlEvent &event = traceControlEvents[i];
    if (i) os << ",";
    os << "{\"pc\":" << event.pc
       << ",\"target\":" << event.target
       << ",\"expected\":" << event.expected
       << ",\"sp\":" << event.sp
       << ",\"cpsr\":" << event.cpsr
       << ",\"kind\":" << event.kind
       << ",\"reg\":" << event.reg
       << ",\"mismatch\":" << (event.mismatch ? "true" : "false") << "}";
  }
  os << "]}";
  textScratch = os.str();
  return textScratch.c_str();
}

const char *dbgCallStackJson() {
  return dbgCallStackJsonLimit(128);
}

const char *chtGetList() {
  textScratch = "";
  CHEATS_LIST *lst = cheatsExport->getCheats();
  int itemCount = cheatsExport->getCheatsNum();
  for (int i = 0; i < itemCount; i++) {
    textScratch += lst[i].description;
    textScratch += "-c!@";
  }
  return textScratch.c_str();
}

int chtAddItem(int id) {
  if (id < 0 || id >= cheatsExport->getCheatsNum()) return -1;
  CHEATS_LIST *lst = cheatsExport->getCheats();
  lst[id].enabled = 1;
  cheats->add_AR_Direct(lst[id]);
  return 0;
}

int utilStrLen(const char *p) { return strlen(p); }

int emuSetOpt(int k, int v) {
  if (k == 0) CommonSettings.fwConfig.language = v;
  return 0;
}

}
