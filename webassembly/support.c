#include <pthread.h>

int pthread_attr_setschedpolicy(pthread_attr_t *attr, int policy) {
  (void)attr;
  (void)policy;
  return 0;
}

int pthread_setname_np(pthread_t thread, const char *name) {
  (void)thread;
  (void)name;
  return 0;
}
