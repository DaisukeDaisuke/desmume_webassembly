#pragma once

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static inline const char *g_get_user_config_dir(void) {
  return ".";
}

static inline char *g_build_filename(const char *first, ...) {
  va_list args;
  size_t len = 1;
  const char *part = first;
  va_start(args, first);
  while (part) {
    len += strlen(part) + 1;
    part = va_arg(args, const char *);
  }
  va_end(args);

  char *out = (char *)malloc(len);
  if (!out) return NULL;
  out[0] = '\0';
  part = first;
  va_start(args, first);
  while (part) {
    if (out[0] && out[strlen(out) - 1] != '/') strcat(out, "/");
    strcat(out, part);
    part = va_arg(args, const char *);
  }
  va_end(args);
  return out;
}

static inline int g_mkdir_with_parents(const char *path, int mode) {
  (void)mode;
  return mkdir(path, 0775);
}

static inline void g_free(void *ptr) {
  free(ptr);
}
