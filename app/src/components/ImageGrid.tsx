import type { ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ImageRecord } from '@scanner-demo/shared';
import { thumbnailSourceFor } from '../api/images';
import { colors, radius, spacing } from '../theme';

/**
 * The thumbnail grid - spec, § Screens — Image library: newest first, paginated.
 *
 * **Only thumbnails are fetched here.** The tiles are a hundred-odd pixels wide and the server
 * renders a 320px JPEG for exactly this; pointing them at `/api/v1/images/:id` would pull a
 * multi-megabyte photograph per tile over a phone's uplink. Acceptance criterion 1 reads the access
 * log during a scroll and expects to see nothing but `/thumb`.
 *
 * `FlatList` rather than a mapped `ScrollView`, from the start: it mounts a window around what is
 * visible and unmounts the rest, so a few hundred thumbnails do not turn into a few hundred live
 * `Image` views. Discovering that at 300 images would mean rewriting the screen instead of the risk
 * having been priced in.
 */

const COLUMNS = 3;

export interface ImageGridProps {
  images: ImageRecord[];
  /** A page is in flight. Distinguished from `refreshing` so the footer spinner is not a flash. */
  loading: boolean;
  refreshing: boolean;
  /** `true` once the server has answered with no further cursor. */
  reachedEnd: boolean;
  header: ReactElement;
  onSelect: (image: ImageRecord) => void;
  onEndReached: () => void;
  onRefresh: () => void;
}

function Tile({
  image,
  size,
  onSelect,
}: {
  image: ImageRecord;
  size: number;
  onSelect: (image: ImageRecord) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${image.variant} ${image.source} capture`}
      style={({ pressed }) => [
        styles.tile,
        { height: size, width: size },
        pressed && styles.pressed,
      ]}
      onPress={() => onSelect(image)}
    >
      {/* The token travels in a header rather than in the URL - ADR-14. */}
      <Image source={thumbnailSourceFor(image.id)} style={styles.thumbnail} resizeMode="cover" />

      <View style={styles.tileBadge}>
        <Text style={styles.tileBadgeText}>
          {image.source === 'camera' ? 'cam' : 'gal'}
          {/* Which pixels these are. Only shown for the archived original, because the uploaded
              variant is the one everything is compared on and labelling it adds noise - ADR-3. */}
          {image.variant === 'original' ? ' · orig' : ''}
        </Text>
      </View>
    </Pressable>
  );
}

export function ImageGrid({
  images,
  loading,
  refreshing,
  reachedEnd,
  header,
  onSelect,
  onEndReached,
  onRefresh,
}: ImageGridProps) {
  const { width } = useWindowDimensions();
  // Computed rather than left to `flex: 1`, so a tile stays square whatever the column count is.
  const size = Math.floor((width - spacing.md * 2 - spacing.xs * (COLUMNS - 1)) / COLUMNS);

  return (
    <FlatList
      data={images}
      keyExtractor={(image) => image.id}
      numColumns={COLUMNS}
      style={styles.list}
      contentContainerStyle={styles.content}
      columnWrapperStyle={styles.column}
      ListHeaderComponent={header}
      renderItem={({ item }) => <Tile image={item} size={size} onSelect={onSelect} />}
      // Windowing: a small window and clipping keep memory flat as the dataset grows.
      initialNumToRender={12}
      windowSize={5}
      removeClippedSubviews
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (!reachedEnd && !loading) {
          onEndReached();
        }
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      ListEmptyComponent={
        loading ? null : (
          <Text style={styles.empty}>
            No images match these filters. Everything the phone has ever uploaded is here, so an
            empty grid with filters cleared means nothing has been captured yet.
          </Text>
        )
      }
      ListFooterComponent={
        <View style={styles.footer}>
          {loading && <ActivityIndicator color={colors.accent} />}
          {reachedEnd && images.length > 0 && (
            <Text style={styles.footerText}>{images.length} image(s) · end of the set</Text>
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: spacing.md },
  column: { gap: spacing.xs, marginBottom: spacing.xs },
  tile: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  thumbnail: { height: '100%', width: '100%' },
  tileBadge: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderTopRightRadius: radius.md,
    bottom: 0,
    left: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    position: 'absolute',
  },
  tileBadgeText: { color: '#ffffff', fontFamily: 'monospace', fontSize: 10 },
  empty: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  footer: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  footerText: { color: colors.textMuted, fontSize: 12 },
  pressed: { opacity: 0.7 },
});
