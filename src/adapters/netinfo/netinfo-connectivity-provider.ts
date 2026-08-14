import type {
  ConnectivityListener,
  ConnectivityProvider,
} from '../../core/contracts/connectivity-provider.js';

export interface NetInfoLikeState {
  readonly isConnected: boolean | null;
  readonly isInternetReachable?: boolean | null;
}

export interface NetInfoLike {
  fetch(): Promise<NetInfoLikeState>;
  addEventListener(listener: (state: NetInfoLikeState) => void): () => void;
}

export interface NetInfoConnectivityOptions {
  readonly netInfo: NetInfoLike;
}

function resolveOnline(state: NetInfoLikeState): boolean {
  if (state.isConnected === false) {
    return false;
  }

  if (state.isInternetReachable === false) {
    return false;
  }

  return state.isConnected === true || state.isInternetReachable === true;
}

export function createNetInfoConnectivityProvider(
  options: NetInfoConnectivityOptions,
): ConnectivityProvider {
  return {
    async isOnline(): Promise<boolean> {
      const state = await options.netInfo.fetch();
      return resolveOnline(state);
    },
    subscribe(listener: ConnectivityListener): () => void {
      return options.netInfo.addEventListener((state) => {
        listener(resolveOnline(state));
      });
    },
  };
}

export function createManualConnectivity(initialOnline = true): ConnectivityProvider & {
  setOnline(value: boolean): void;
} {
  let online = initialOnline;
  const listeners = new Set<ConnectivityListener>();

  return {
    async isOnline(): Promise<boolean> {
      return online;
    },
    subscribe(listener: ConnectivityListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOnline(value: boolean): void {
      if (online === value) {
        return;
      }
      online = value;
      for (const listener of listeners) {
        listener(online);
      }
    },
  };
}
