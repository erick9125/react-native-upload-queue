export interface FileProvider {
  exists(uri: string): Promise<boolean>;
  getSize(uri: string): Promise<number | undefined>;
}
