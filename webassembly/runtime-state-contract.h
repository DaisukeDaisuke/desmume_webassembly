#ifndef DESMUME_WASM_RUNTIME_STATE_CONTRACT_H
#define DESMUME_WASM_RUNTIME_STATE_CONTRACT_H

#include <stddef.h>
#include <stdint.h>

template <typename Reallocate>
inline void *prepareRomStorage(unsigned char *&buffer, int &capacity, int &length,
                               int requestedLength, Reallocate reallocate) {
  if (requestedLength <= 0) return NULL;
  if (requestedLength > capacity) {
    unsigned char *resized = (unsigned char *)reallocate(buffer, (size_t)requestedLength);
    if (!resized) return NULL;
    buffer = resized;
    capacity = requestedLength;
  }
  length = requestedLength;
  return buffer;
}

inline void beginRomLoadState(bool &romLoaded, bool &paused, volatile bool &execute) {
  romLoaded = false;
  paused = true;
  execute = false;
}

inline void finishRomLoadState(int length, int &romLength, bool &romLoaded,
                               bool &paused, volatile bool &execute) {
  romLength = length;
  romLoaded = true;
  paused = false;
  execute = true;
}

inline bool uint32RangeFits(uint32_t address, size_t length) {
  return (uint64_t)address + (uint64_t)length <= 0x100000000ULL;
}

template <typename BreakpointList>
inline void clearAllBreakpointState(BreakpointList (&execBreakpoints)[2],
                                    BreakpointList (&readBreakpoints)[2],
                                    BreakpointList (&writeBreakpoints)[2],
                                    bool (&specialBreakpoints)[3]) {
  for (int index = 0; index < 2; index++) {
    execBreakpoints[index].clear();
    readBreakpoints[index].clear();
    writeBreakpoints[index].clear();
  }
  for (int index = 0; index < 3; index++) specialBreakpoints[index] = false;
}

template <typename Lanes, typename CallCounts, typename Events>
inline void clearTraceState(Lanes &lanes, size_t &activeLane, uint32_t &nextLaneId,
                            CallCounts &callCounts, Events &events,
                            uint32_t (&pendingIrqResume)[2]) {
  lanes.clear();
  activeLane = 0;
  nextLaneId = 1;
  callCounts.clear();
  events.clear();
  pendingIrqResume[0] = 0;
  pendingIrqResume[1] = 0;
}

#endif
