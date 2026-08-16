import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import NetInfo from '@react-native-community/netinfo';
import {
  createHttpUploadTransport,
  createNetInfoConnectivityProvider,
  createSQLiteUploadStorage,
  createUploadQueue,
  type UploadQueue,
  type UploadTask,
} from '@erickmorales91/react-native-upload-queue';
import { openExpoSQLiteDriver } from './expo-sqlite-driver';

/**
 * Point this at the example server in `../server`.
 *
 *   iOS simulator      http://localhost:8787
 *   Android emulator   http://10.0.2.2:8787
 *   Physical device    http://<your LAN IP>:8787
 */
const BASE_URL = 'http://localhost:8787';

const connectivity = createNetInfoConnectivityProvider({
  netInfo: {
    async fetch() {
      const state = await NetInfo.fetch();
      return { isConnected: state.isConnected, isInternetReachable: state.isInternetReachable };
    },
    addEventListener(listener) {
      return NetInfo.addEventListener((state) => {
        listener({ isConnected: state.isConnected, isInternetReachable: state.isInternetReachable });
      });
    },
  },
});

const queue: UploadQueue = createUploadQueue({
  // A file-backed database, so uploads survive a reload and a cold start.
  storage: createSQLiteUploadStorage({
    databaseName: 'uploads.db',
    openDriver: openExpoSQLiteDriver,
  }),
  // No `buildBody`: this deliberately exercises the default React Native
  // multipart part, which is the code path Node can never run.
  transport: createHttpUploadTransport({
    baseUrl: BASE_URL,
    timeoutMs: 60_000,
  }),
  connectivity,
  concurrency: 2,
  retry: { maxAttempts: 5, initialDelayMs: 2_000 },
  // Shortened from five minutes so abandoned-upload recovery is observable
  // within a smoke test rather than after a coffee break.
  recovery: { processingTimeoutMs: 10_000 },
  progress: { eventThrottleMs: 100 },
  logger: {
    debug: () => undefined,
    info: (message, context) => console.log('[queue]', message, context ?? ''),
    warn: (message, context) => console.warn('[queue]', message, context ?? ''),
    error: (message, context) => console.error('[queue]', message, context ?? ''),
  },
});

const STATUS_COLOR: Record<string, string> = {
  pending: '#8a6d00',
  uploading: '#0b5cad',
  completed: '#1c7a3e',
  failed: '#a3232b',
  blocked: '#a3232b',
  paused: '#5b5b5b',
  cancelled: '#5b5b5b',
};

function ProgressBar({ progress }: { progress: number }): React.JSX.Element {
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} />
    </View>
  );
}

export default function App(): React.JSX.Element {
  const [uploads, setUploads] = useState<readonly UploadTask[]>([]);
  const [slowMode, setSlowMode] = useState(true);
  const [ready, setReady] = useState(false);
  const slowModeRef = useRef(slowMode);
  slowModeRef.current = slowMode;

  const refresh = useCallback(async () => {
    setUploads(await queue.list());
  }, []);

  useEffect(() => {
    const unsubscribe = queue.subscribe(() => {
      void refresh();
    });

    void (async () => {
      try {
        // start() recovers abandoned uploads, drains what is pending, and arms
        // the retry timer. Anything left over from the previous run resumes here.
        await queue.start();
        setReady(true);
        await refresh();
      } catch (error) {
        Alert.alert('Queue failed to start', String(error));
      }
    })();

    return () => {
      unsubscribe();
      void queue.stop();
    };
  }, [refresh]);

  const pickAndEnqueue = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo access to pick a file to upload.');
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
    if (picked.canceled) {
      return;
    }

    const asset = picked.assets[0];
    if (!asset) {
      return;
    }

    // `?delay=` makes the example server hold the request open so progress and
    // pause/cancel are actually observable on screen.
    const destination = slowModeRef.current ? '/uploads?delay=4000' : '/uploads';

    try {
      await queue.enqueue({
        fileUri: asset.uri,
        fileName: asset.fileName ?? `photo-${Date.now()}.jpg`,
        mimeType: asset.mimeType ?? 'image/jpeg',
        ...(asset.fileSize !== undefined ? { size: asset.fileSize } : {}),
        destination,
        metadata: { pickedAt: new Date().toISOString() },
      });
      await refresh();
    } catch (error) {
      Alert.alert('Enqueue failed', String(error));
    }
  }, [refresh]);

  const act = useCallback(
    (label: string, run: () => Promise<unknown>) => async () => {
      try {
        await run();
        await refresh();
      } catch (error) {
        Alert.alert(`${label} failed`, String(error));
      }
    },
    [refresh],
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Upload queue</Text>
        <Text style={styles.subtitle}>{BASE_URL}</Text>
        <Text style={styles.subtitle}>{ready ? 'queue started' : 'starting…'}</Text>

        <Pressable style={styles.primary} onPress={() => void pickAndEnqueue()}>
          <Text style={styles.primaryText}>Pick a photo and enqueue</Text>
        </Pressable>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Slow mode (server delays 4s)</Text>
          <Switch value={slowMode} onValueChange={setSlowMode} />
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={styles.secondary} onPress={act('Process', () => queue.process())}>
            <Text style={styles.secondaryText}>Process now</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={act('Purge', () => queue.purgeCompleted())}
          >
            <Text style={styles.secondaryText}>Purge completed</Text>
          </Pressable>
        </View>

        {uploads.length === 0 ? (
          <Text style={styles.empty}>
            Nothing queued yet. Pick a photo, then try airplane mode, killing the app
            mid-upload, or pausing.
          </Text>
        ) : null}

        {uploads.map((task) => (
          <View key={task.id} style={styles.card}>
            <Text style={styles.fileName} numberOfLines={1}>
              {task.fileName}
            </Text>
            <Text style={[styles.status, { color: STATUS_COLOR[task.status] ?? '#333' }]}>
              {task.status} · attempt {task.attempts}/{task.maxAttempts}
              {task.remoteId ? ` · ${task.remoteId}` : ''}
            </Text>
            <ProgressBar progress={task.progress} />

            {task.lastError ? (
              <Text style={styles.error}>
                {task.lastError.kind}: {task.lastError.message}
              </Text>
            ) : null}
            {task.nextAttemptAt ? (
              <Text style={styles.meta}>next attempt {task.nextAttemptAt}</Text>
            ) : null}

            <View style={styles.buttonRow}>
              {task.status === 'pending' || task.status === 'uploading' ? (
                <Pressable
                  style={styles.tiny}
                  onPress={act('Pause', () => queue.pause(task.id))}
                >
                  <Text style={styles.tinyText}>Pause</Text>
                </Pressable>
              ) : null}
              {task.status === 'paused' ? (
                <Pressable
                  style={styles.tiny}
                  onPress={act('Resume', () => queue.resume(task.id))}
                >
                  <Text style={styles.tinyText}>Resume</Text>
                </Pressable>
              ) : null}
              {task.status === 'failed' || task.status === 'blocked' ? (
                <Pressable
                  style={styles.tiny}
                  onPress={act('Retry', () => queue.retry(task.id))}
                >
                  <Text style={styles.tinyText}>Retry</Text>
                </Pressable>
              ) : null}
              {task.status !== 'completed' && task.status !== 'cancelled' ? (
                <Pressable
                  style={styles.tiny}
                  onPress={act('Cancel', () => queue.cancel(task.id))}
                >
                  <Text style={styles.tinyText}>Cancel</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f6f7' },
  content: { padding: 20, paddingTop: 64, gap: 12 },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 13, color: '#666' },
  primary: {
    backgroundColor: '#0b5cad',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 14, color: '#333' },
  buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  secondary: {
    flex: 1,
    backgroundColor: '#e3e5e8',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryText: { fontWeight: '600', color: '#222' },
  empty: { color: '#777', marginTop: 16, lineHeight: 20 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
  },
  fileName: { fontWeight: '600', fontSize: 15 },
  status: { fontSize: 13, fontWeight: '600' },
  meta: { fontSize: 11, color: '#888' },
  error: { fontSize: 12, color: '#a3232b' },
  track: { height: 6, backgroundColor: '#e3e5e8', borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: '#0b5cad' },
  tiny: {
    backgroundColor: '#e3e5e8',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  tinyText: { fontWeight: '600', fontSize: 13, color: '#222' },
});
