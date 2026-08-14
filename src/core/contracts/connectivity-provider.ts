export type ConnectivityListener = (online: boolean) => void;

export interface ConnectivityProvider {
  isOnline(): Promise<boolean>;
  subscribe(listener: ConnectivityListener): () => void;
}
