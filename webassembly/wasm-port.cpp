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
static EMUFILE_MEMORY *savFile = new EMUFILE_MEMORY();
static EMUFILE_MEMORY *stateFile = new EMUFILE_MEMORY();
static u8 *romBuffer = NULL;
static int romBufferCap = 0;
static int romLen = 0;
static s16 audioBuffer[16384 * 2];
static int samplesRead = 0;
static int samplesDesired = 0;
volatile bool execute = true;
static bool paused = true;
static bool debuggerEnabled = true;
static bool traceEnabled = false;
static u64 frameCounter = 0;

static std::vector<u32> execBreakpoints[2];
static std::vector<u32> readBreakpoints[2];
static std::vector<u32> writeBreakpoints[2];
static std::string textScratch;

u32 dstFrameBuffer[2][256 * 192];

extern "C" unsigned cpu_features_get_core_amount(void) { return 1; }

static armcpu_t *cpuFor(int proc) { return proc == 0 ? &NDS_ARM9 : &NDS_ARM7; }

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

void reset() {
  NDS_Reset();
  frameCounter = 0;
}

int loadROM(int len) {
  romLen = len;
  emuLastError = -2;
  if (!NDS_LoadROM("rom.nds")) return emuLastError;
  SPU_SetSynchMode(ESynchMode_Synchronous, ESynchMethod_N);
  SPU_SetVolume(35);
  paused = false;
  frameCounter = 0;
  return 0;
}

int runFrame(int shouldDraw, u32 keys, int touched, u32 touchX, u32 touchY) {
  if (paused) return 0;
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
  frameCounter++;
  if (shouldDraw) gpu_screen_to_rgb((u32 *)dstFrameBuffer);
  return 0;
}

int runFrames(int count, int shouldDraw, u32 keys) {
  if (count < 0) return -1;
  for (int i = 0; i < count; i++) runFrame(shouldDraw && i == count - 1, keys, 0, 0, 0);
  return count;
}

int fillAudioBuffer(int bufLenToFill) {
  samplesDesired = bufLenToFill;
  samplesRead = 0;
  SPU_Emulate_user();
  return samplesRead;
}

int savGetSize() { return savFile->size(); }

void *savGetPointer(int desiredSize) {
  if (desiredSize > 0) {
    savFile->truncate(desiredSize);
    savFile->fseek(0, SEEK_SET);
  }
  return savFile->buf();
}

int savUpdateChangeFlag() {
  return 1;
}

int savImportFromFile() {
  bool ok = MMU_new.backupDevice.importData("import.sav");
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
  stateFile->truncate(size);
  stateFile->fseek(0, SEEK_SET);
  return savestate_load(*stateFile) ? 0 : -1;
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
  return paused ? 1 : 0;
}

int isPaused() { return paused ? 1 : 0; }

int debuggerSetEnabled(int value) {
  debuggerEnabled = value != 0;
  return debuggerEnabled ? 1 : 0;
}

int traceSetEnabled(int value) {
  traceEnabled = value != 0;
  return traceEnabled ? 1 : 0;
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

u32 dbgRead8(int proc, u32 addr) { return MMU_read8(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr); }
u32 dbgRead16(int proc, u32 addr) { return MMU_read16(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr); }
u32 dbgRead32(int proc, u32 addr) { return MMU_read32(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr); }

int dbgWrite8(int proc, u32 addr, u32 value) {
  MMU_write8(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr, value & 0xff);
  return 0;
}
int dbgWrite16(int proc, u32 addr, u32 value) {
  MMU_write16(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr, value & 0xffff);
  return 0;
}
int dbgWrite32(int proc, u32 addr, u32 value) {
  MMU_write32(proc == 0 ? ARMCPU_ARM9 : ARMCPU_ARM7, addr, value);
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

int dbgSetExecBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(execBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}
int dbgSetReadBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(readBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}
int dbgSetWriteBreakpoint(int proc, u32 addr, int enabled) {
  return setBreakpoint(writeBreakpoints[proc == 0 ? 0 : 1], addr, enabled);
}

int dbgStep(int proc, int count) {
  if (count < 1) count = 1;
  bool wasPaused = paused;
  paused = false;
  for (int i = 0; i < count; i++) {
    if (proc == 0) armcpu_exec<0>();
    else armcpu_exec<1>();
  }
  paused = wasPaused;
  return count;
}

int dbgStepOver(int proc) {
  armcpu_t *cpu = cpuFor(proc);
  const u32 next = cpu->instruct_adr + (cpu->CPSR.bits.T ? 2 : 4);
  int count = 0;
  do {
    dbgStep(proc, 1);
    count++;
  } while (cpu->instruct_adr != next && count < 4096);
  return count;
}

const char *dbgGetStatusJson() {
  std::ostringstream os;
  os << "{\"paused\":" << (paused ? "true" : "false")
     << ",\"debuggerEnabled\":" << (debuggerEnabled ? "true" : "false")
     << ",\"traceEnabled\":" << (traceEnabled ? "true" : "false")
     << ",\"frame\":" << frameCounter
     << ",\"arm9\":{\"pc\":" << NDS_ARM9.instruct_adr << ",\"cpsr\":" << NDS_ARM9.CPSR.val << "}"
     << ",\"arm7\":{\"pc\":" << NDS_ARM7.instruct_adr << ",\"cpsr\":" << NDS_ARM7.CPSR.val << "}}";
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

const char *dbgStackTrace(int proc, int words) {
  if (words < 1) words = 16;
  if (words > 256) words = 256;
  u32 sp = dbgGetReg(proc, 13);
  std::ostringstream os;
  os << "trace=" << (traceEnabled ? "on" : "off") << " sp=0x" << std::hex << sp << "\n";
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
