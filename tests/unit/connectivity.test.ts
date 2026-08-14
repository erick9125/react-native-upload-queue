import { describe, expect, it } from 'vitest';
import {
  createManualConnectivity,
  createNetInfoConnectivityProvider,
} from '../../src/adapters/netinfo/netinfo-connectivity-provider.js';

describe('connectivity providers', () => {
  it('resolves NetInfo connected state as online', async () => {
    const provider = createNetInfoConnectivityProvider({
      netInfo: {
        async fetch() {
          return { isConnected: true, isInternetReachable: true };
        },
        addEventListener() {
          return () => undefined;
        },
      },
    });

    expect(await provider.isOnline()).toBe(true);
  });

  it('treats isInternetReachable false as offline', async () => {
    const provider = createNetInfoConnectivityProvider({
      netInfo: {
        async fetch() {
          return { isConnected: true, isInternetReachable: false };
        },
        addEventListener() {
          return () => undefined;
        },
      },
    });

    expect(await provider.isOnline()).toBe(false);
  });

  it('notifies subscribers when manual connectivity changes', async () => {
    const provider = createManualConnectivity(true);
    const seen: boolean[] = [];
    const unsubscribe = provider.subscribe((online) => {
      seen.push(online);
    });

    provider.setOnline(false);
    provider.setOnline(false);
    provider.setOnline(true);
    unsubscribe();
    provider.setOnline(false);

    expect(seen).toEqual([false, true]);
    expect(await provider.isOnline()).toBe(false);
  });
});
