import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { groupAttemptsByImage } from '@scanner-demo/shared';
import type { Attempt, ImageAttempts, ImageRecord } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { fetchAttemptPage } from '../api/attempts';
import { fetchImages } from '../api/images';
import {
  DEFAULT_HISTORY_FILTERS,
  HistoryFilters,
  toAttemptFilters,
  toExportFilters,
  type HistoryFilterState,
} from '../components/HistoryFilters';
import { ImageAttemptRow } from '../components/ImageAttemptRow';
import { MethodSummary } from '../components/MethodSummary';
import { formatBytes } from '../format';
import { collectExport, writeExport } from '../lib/exportJson';
import type { ExportProgress } from '../lib/exportJson';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, radius, spacing } from '../theme';

/**
 * History - spec, § Screens — History, and the actual deliverable of this POC.
 *
 * Every attempt, grouped by source image, so one photograph processed four ways can be read across
 * in a line, with a per-method summary over whatever the filters currently select and a JSON export
 * of the rows behind it.
 *
 * **The summary is computed over the filtered set the server returned, not over the pages that have
 * been scrolled into view.** History pages as the operator scrolls; a median that grew as they
 * scrolled would be a different number every time it was read. So the figures are labelled with how
 * much of the set they cover, and the export fetches the whole thing again rather than reusing what
 * is on screen.
 *
 * There is no leaderboard here on purpose - see `MethodSummary`.
 */

const PAGE_SIZE = 100;

export function HistoryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [filters, setFilters] = useState<HistoryFilterState>(DEFAULT_HISTORY_FILTERS);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [images, setImages] = useState<Map<string, ImageRecord>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const query = useMemo(() => toAttemptFilters(filters), [filters]);

  /**
   * Which set of filters the page in flight belongs to.
   *
   * Without it a slow first page for one filter can land after a fast first page for the next and
   * overwrite it, and the summary would then be computed over rows the chips say are excluded.
   */
  const generation = useRef(0);

  /** The image records behind whatever rows have arrived, for the thumbnails and the metadata. */
  const loadImagesFor = useCallback(async (rows: Attempt[], token: number) => {
    const groups = [...new Set(rows.map((attempt) => attempt.captureGroupId))];

    if (groups.length === 0) {
      return;
    }

    // One request per capture group would be dozens of round trips; one sweep of the listing is
    // one, and the Library holds hundreds of rows rather than thousands.
    try {
      const page = await fetchImages({ limit: 100 });
      if (token !== generation.current) {
        return;
      }
      setImages((current) => {
        const next = new Map(current);
        for (const image of page.items) {
          next.set(image.id, image);
        }
        return next;
      });
    } catch {
      // Deliberately swallowed: the rows are built from attempts, which name their own image, so a
      // failed metadata fetch costs a thumbnail caption and nothing that is measured.
    }
  }, []);

  const loadFirstPage = useCallback(
    async (mode: 'load' | 'refresh') => {
      const token = (generation.current += 1);
      setError(null);
      if (mode === 'refresh') {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const page = await fetchAttemptPage({ ...query, limit: PAGE_SIZE });
        if (token !== generation.current) {
          return;
        }
        setAttempts(page.items);
        setCursor(page.nextCursor);
        void loadImagesFor(page.items, token);
      } catch (failure: unknown) {
        if (token === generation.current) {
          setError(
            failure instanceof ApiError || failure instanceof Error
              ? failure.message
              : 'History could not be loaded',
          );
        }
      } finally {
        if (token === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [loadImagesFor, query],
  );

  const loadNextPage = useCallback(async () => {
    if (cursor === null || loading || refreshing) {
      return;
    }

    const token = generation.current;
    setLoading(true);

    try {
      const page = await fetchAttemptPage({ ...query, limit: PAGE_SIZE, cursor });
      if (token !== generation.current) {
        return;
      }
      setAttempts((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      void loadImagesFor(page.items, token);
    } catch (failure: unknown) {
      if (token === generation.current) {
        setError(
          failure instanceof ApiError || failure instanceof Error
            ? failure.message
            : 'The next page could not be loaded',
        );
      }
    } finally {
      if (token === generation.current) {
        setLoading(false);
      }
    }
  }, [cursor, loadImagesFor, loading, query, refreshing]);

  useEffect(() => {
    void loadFirstPage('load');
  }, [loadFirstPage]);

  const rows = useMemo(() => groupAttemptsByImage(attempts), [attempts]);

  const runExport = useCallback(async () => {
    setExporting(true);
    setExportStatus('Fetching every row, not just the ones on screen…');

    try {
      const file = await collectExport({
        filters: toExportFilters(filters),
        query,
        onProgress: (progress: ExportProgress) =>
          setExportStatus(`${progress.count} ${progress.stage}…`),
      });

      setExportStatus('Writing…');
      const written = await writeExport(file);

      setExportStatus(
        [
          `${file.attempts.length} attempts, ${file.images.length} images, ${file.barcodeScans.length} barcode scans · ${formatBytes(written.bytes)}`,
          written.savedUri === null
            ? `Saved in the app only: ${written.file.uri}. No folder was chosen, so nothing was copied out.`
            : `Copied to ${written.savedUri}`,
        ].join('\n'),
      );
    } catch (failure: unknown) {
      setExportStatus(
        `Export failed: ${failure instanceof ApiError || failure instanceof Error ? failure.message : 'unknown error'}`,
      );
    } finally {
      setExporting(false);
    }
  }, [filters, query]);

  const openImage = useCallback(
    (row: ImageAttempts) => {
      const image = images.get(row.imageId);
      if (image !== undefined) {
        navigation.navigate('ImageDetail', { image });
      }
    },
    [images, navigation],
  );

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.imageId}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFirstPage('refresh')}
            tintColor={colors.accent}
          />
        }
        onEndReached={() => void loadNextPage()}
        onEndReachedThreshold={0.5}
        renderItem={({ item }) => (
          <ImageAttemptRow
            row={item}
            image={images.get(item.imageId) ?? null}
            onPress={openImage}
          />
        )}
        ListHeaderComponent={
          <View style={styles.header}>
            <HistoryFilters
              state={filters}
              onChange={setFilters}
              summary={
                cursor === null
                  ? `${attempts.length} run(s) over ${rows.length} image(s)`
                  : `${attempts.length}+ run(s), paging`
              }
            />

            {cursor !== null && (
              // The one thing a reader must not assume. Until the last page has arrived the
              // summary below covers what has been fetched, and saying so is the difference
              // between a partial figure and a wrong one.
              <Text style={styles.warning}>
                More pages remain. The figures below cover the {attempts.length} run(s) fetched so
                far — scroll to the end, or export, for the whole filtered set.
              </Text>
            )}

            <MethodSummary attempts={attempts} sourceFiltered={filters.source !== 'all'} />

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: exporting, disabled: exporting }}
              disabled={exporting}
              style={({ pressed }) => [
                styles.export,
                exporting && styles.exportBusy,
                pressed && styles.pressed,
              ]}
              onPress={() => void runExport()}
            >
              <Text style={styles.exportLabel}>
                {exporting ? 'Exporting…' : 'Export everything as JSON'}
              </Text>
              <Text style={styles.exportNote}>
                Full rows for the current filters: raw OCR text, every candidate the parser
                considered, and the pricing, parser and timing versions on every one. Barcode scans
                travel in their own array — ADR-1.
              </Text>
            </Pressable>

            {exportStatus !== null && <Text style={styles.status}>{exportStatus}</Text>}

            {error !== null && <Text style={styles.error}>{error}</Text>}

            <Text style={styles.rowsLabel}>Attempts by source image</Text>
          </View>
        }
        ListFooterComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} style={styles.footer} />
          ) : rows.length > 0 && cursor === null ? (
            <Text style={styles.footerNote}>Every run matching these filters is above.</Text>
          ) : null
        }
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.footerNote}>
              Nothing matches these filters. Capture an image, or run a method over one already in
              the Library.
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  content: { padding: spacing.md },
  header: { gap: spacing.md, marginBottom: spacing.md },
  warning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    fontSize: 12,
    lineHeight: 17,
    padding: spacing.sm,
  },
  export: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  exportBusy: { opacity: 0.6 },
  exportLabel: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  exportNote: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  status: { color: colors.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  error: { color: colors.offline, fontSize: 13, lineHeight: 18 },
  rowsLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  footer: { paddingVertical: spacing.md },
  footerNote: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    paddingVertical: spacing.md,
  },
  pressed: { opacity: 0.7 },
});
