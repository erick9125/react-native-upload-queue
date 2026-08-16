import { useEffect, useMemo, useState } from 'react';
import { Button, FlatList, Text, View } from 'react-native';
import {
  createHttpUploadTransport,
  createManualConnectivity,
  createMemoryUploadStorage,
  createUploadQueue,
  type UploadQueueEvent,
  type UploadTask,
} from '@erickmorales91/react-native-upload-queue';

const connectivity = createManualConnectivity(true);

const queue = createUploadQueue({
  storage: createMemoryUploadStorage(),
  transport: createHttpUploadTransport({
    baseUrl: 'http://localhost:8787',
  }),
  connectivity,
  concurrency: 2,
});

function bar(progress: number): string {
  const filled = Math.round(progress * 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(progress * 100)}%`;
}

export function UploadQueueExample(): React.JSX.Element {
  const [uploads, setUploads] = useState<readonly UploadTask[]>([]);

  const refresh = useMemo(
    () => async () => {
      setUploads(await queue.list());
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = queue.subscribe((_event: UploadQueueEvent) => {
      void refresh();
    });
    void queue.start().then(refresh);
    return () => {
      unsubscribe();
      void queue.stop();
    };
  }, [refresh]);

  return (
    <View style={{ flex: 1, padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '700' }}>Uploads</Text>
      <Button
        title="Enqueue demo file"
        onPress={() => {
          void queue
            .enqueue({
              fileUri: 'file://photo.jpg',
              fileName: `photo-${Date.now()}.jpg`,
              mimeType: 'image/jpeg',
              destination: '/uploads',
            })
            .then(refresh);
        }}
      />
      <Button title="Simulate offline" onPress={() => connectivity.setOnline(false)} />
      <Button
        title="Reconnect"
        onPress={() => {
          connectivity.setOnline(true);
        }}
      />
      <FlatList
        data={[...uploads]}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 12 }}>
            <Text>{item.fileName}</Text>
            <Text>{bar(item.progress)}</Text>
            <Text>{item.status}</Text>
            {item.status === 'uploading' || item.status === 'pending' ? (
              <Button title="Pause" onPress={() => void queue.pause(item.id).then(refresh)} />
            ) : null}
            {item.status === 'paused' ? (
              <Button title="Resume" onPress={() => void queue.resume(item.id).then(refresh)} />
            ) : null}
            {item.status !== 'completed' && item.status !== 'cancelled' ? (
              <Button title="Cancel" onPress={() => void queue.cancel(item.id).then(refresh)} />
            ) : null}
          </View>
        )}
      />
    </View>
  );
}
