#pragma once

#include <stdint.h>
#include <sys/time.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PCAP_ERRBUF_SIZE 256
#define PCAP_OPENFLAG_PROMISCUOUS 1

typedef unsigned char u_char;
typedef struct pcap pcap_t;

struct pcap_pkthdr {
  struct timeval ts;
  uint32_t caplen;
  uint32_t len;
};

typedef struct pcap_if {
  struct pcap_if *next;
  char *name;
  char *description;
  void *addresses;
  uint32_t flags;
} pcap_if_t;

typedef void (*pcap_handler)(u_char *, const struct pcap_pkthdr *, const u_char *);

static inline int pcap_findalldevs(pcap_if_t **alldevs, char *errbuf) {
  (void)errbuf;
  if (alldevs) *alldevs = 0;
  return 0;
}

static inline void pcap_freealldevs(pcap_if_t *alldevs) {
  (void)alldevs;
}

static inline pcap_t *pcap_open_live(const char *source, int snaplen, int flags, int readtimeout, char *errbuf) {
  (void)source;
  (void)snaplen;
  (void)flags;
  (void)readtimeout;
  if (errbuf) errbuf[0] = 0;
  return 0;
}

static inline void pcap_close(pcap_t *dev) { (void)dev; }
static inline int pcap_setnonblock(pcap_t *dev, int nonblock, char *errbuf) {
  (void)dev;
  (void)nonblock;
  if (errbuf) errbuf[0] = 0;
  return 0;
}
static inline int pcap_sendpacket(pcap_t *dev, const u_char *data, int len) {
  (void)dev;
  (void)data;
  (void)len;
  return -1;
}
static inline int pcap_dispatch(pcap_t *dev, int num, pcap_handler callback, u_char *userdata) {
  (void)dev;
  (void)num;
  (void)callback;
  (void)userdata;
  return 0;
}
static inline void pcap_breakloop(pcap_t *dev) { (void)dev; }

#ifdef __cplusplus
}
#endif
