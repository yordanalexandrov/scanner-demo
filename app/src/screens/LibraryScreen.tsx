import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ImageRecord } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { fetchImages } from '../api/images';
import { ImageGrid } from '../components/ImageGrid';
import {
  DEFAULT_FILTERS,
  LibraryFilters,
  toImageFilters,
  type LibraryFilterState,
} from '../components/LibraryFilters';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, spacing } from '../theme';

/**
 * The image library - spec, § Screens — Image library.
 *
 * **Built before the three remaining engines on purpose.** Once a library of stored images exists,
 * every engine added afterwards is measured against packaging already collected instead of the
 * packaging being re-shot for each one.
 *
 * Every filter is a server query. Nothing here narrows a page after it arrives: the count in the
 * filter header has to mean "rows on the server matching this", not "rows that happened to be in the
 * pages fetched so far".
 */

const PAGE_SIZE = 50;

export function LibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [filters, setFilters] = useState<LibraryFilterState>(DEFAULT_FILTERS);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => toImageFilters(filters), [filters]);

  /**
   * Which set of filters the page in flight belongs to.
   *
   * Without it, a slow first page for one filter can land after a fast first page for the next and
   * overwrite it - the grid would then show rows the chips say are excluded. The counter is bumped
   * for a new query and left alone for an append, because an append belongs to the query it started
   * under.
   */
  const generation = useRef(0);

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
        const page = await fetchImages({ ...query, limit: PAGE_SIZE });
        if (token !== generation.current) {
          return;
        }
        setImages(page.items);
        setCursor(page.nextCursor);
      } catch (failure: unknown) {
        if (token === generation.current) {
          setError(
            failure instanceof ApiError || failure instanceof Error
              ? failure.message
              : 'The library could not be loaded',
          );
        }
      } finally {
        if (token === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [query],
  );

  const loadNextPage = useCallback(async () => {
    if (cursor === null || loading || refreshing) {
      return;
    }

    const token = generation.current;
    setLoading(true);

    try {
      const page = await fetchImages({ ...query, limit: PAGE_SIZE, cursor });
      if (token !== generation.current) {
        return;
      }
      setImages((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
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
  }, [cursor, loading, query, refreshing]);

  useEffect(() => {
    void loadFirstPage('load');
  }, [loadFirstPage]);

  const openDetail = useCallback(
    (image: ImageRecord) => navigation.navigate('ImageDetail', { image }),
    [navigation],
  );

  return (
    <View style={styles.screen}>
      <ImageGrid
        images={images}
        loading={loading}
        refreshing={refreshing}
        reachedEnd={cursor === null}
        onSelect={openDetail}
        onEndReached={() => void loadNextPage()}
        onRefresh={() => void loadFirstPage('refresh')}
        header={
          <View>
            <LibraryFilters
              state={filters}
              onChange={setFilters}
              summary={
                cursor === null ? `${images.length} image(s)` : `${images.length}+ image(s), paging`
              }
            />
            {error !== null && <Text style={styles.error}>{error}</Text>}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  error: { color: colors.offline, fontSize: 13, marginBottom: spacing.sm },
});
