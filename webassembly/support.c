#include <pthread.h>
#include <errno.h>

// WebAssembly does not expose native pthread scheduling or OS thread names here.
// Return ENOTSUP so callers cannot mistake these compatibility stubs for success.
int pthread_attr_setschedpolicy(pthread_attr_t *attr, int policy) {
  (void)attr;
  (void)policy;
  return ENOTSUP;
}

int pthread_setname_np(pthread_t thread, const char *name) {
  (void)thread;
  (void)name;
  return ENOTSUP;
}
