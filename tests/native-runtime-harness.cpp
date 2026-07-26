#include <assert.h>
#include <errno.h>
#include <pthread.h>

#include <map>
#include <vector>

#include "../webassembly/runtime-state-contract.h"

int main() {
  unsigned char original[4] = {1, 2, 3, 4};
  unsigned char expanded[8] = {};
  unsigned char *buffer = original;
  int capacity = 4;
  int length = 4;
  void *failed = prepareRomStorage(buffer, capacity, length, 8,
                                   [](void *, size_t) -> void * { return NULL; });
  assert(failed == NULL);
  assert(buffer == original && capacity == 4 && length == 4);
  void *prepared = prepareRomStorage(buffer, capacity, length, 8,
                                     [&](void *, size_t) -> void * { return expanded; });
  assert(prepared == expanded);
  assert(buffer == expanded && capacity == 8 && length == 8);

  bool romLoaded = true;
  bool paused = false;
  bool execute = true;
  int romLength = 8;
  beginRomLoadState(romLoaded, paused, execute);
  assert(!romLoaded && paused && !execute && romLength == 8);
  finishRomLoadState(16, romLength, romLoaded, paused, execute);
  assert(romLoaded && !paused && execute && romLength == 16);

  std::vector<unsigned> execBreakpoints[2] = {{1}, {2}};
  std::vector<unsigned> readBreakpoints[2] = {{3}, {4}};
  std::vector<unsigned> writeBreakpoints[2] = {{5}, {6}};
  bool specialBreakpoints[3] = {true, true, true};
  clearAllBreakpointState(execBreakpoints, readBreakpoints, writeBreakpoints,
                          specialBreakpoints);
  for (int index = 0; index < 2; index++) {
    assert(execBreakpoints[index].empty());
    assert(readBreakpoints[index].empty());
    assert(writeBreakpoints[index].empty());
  }
  assert(!specialBreakpoints[0] && !specialBreakpoints[1] && !specialBreakpoints[2]);

  std::vector<int> lanes = {1, 2};
  size_t activeLane = 1;
  uint32_t nextLaneId = 9;
  std::map<uint32_t, uint32_t> callCounts = {{1, 2}};
  std::vector<int> events = {3};
  uint32_t pendingIrqResume[2] = {4, 5};
  clearTraceState(lanes, activeLane, nextLaneId, callCounts, events, pendingIrqResume);
  assert(lanes.empty() && activeLane == 0 && nextLaneId == 1);
  assert(callCounts.empty() && events.empty());
  assert(pendingIrqResume[0] == 0 && pendingIrqResume[1] == 0);

  assert(uint32RangeFits(0xffffffffU, 1));
  assert(!uint32RangeFits(0xffffffffU, 2));
  assert(!uint32RangeFits(0xfffffff0U, 32));

  pthread_attr_t attr;
  assert(pthread_attr_setschedpolicy(&attr, 0) == ENOTSUP);
  assert(pthread_setname_np(pthread_self(), "desmume-test") == ENOTSUP);
  return 0;
}
