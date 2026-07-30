import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { BarcodeScreen } from '../screens/BarcodeScreen';
import { CaptureScreen } from '../screens/CaptureScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { ResultScreen } from '../screens/ResultScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { colors } from '../theme';

/**
 * The complete navigation graph, registered in full from phase 03.
 *
 * Four of the five destinations are placeholders until their phase lands. They are wired up now
 * anyway, so the graph is reviewable as a whole rather than growing a screen at a time - and so a
 * later phase adds a screen's contents without also having to touch navigation.
 */

export type RootStackParamList = {
  Home: undefined;
  Barcode: undefined;
  Capture: undefined;
  Library: undefined;
  History: undefined;
  /** The attempts recorded against one stored image - phase 05, spec screen 5. */
  Result: { imageId: string };
};

// Declaring the map globally is what makes `navigation.navigate` typed at every call site, so a
// renamed route or a missing parameter is a compile error rather than a runtime no-op.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerTintColor: colors.text,
          headerStyle: { backgroundColor: colors.surface },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'scanner-demo' }} />
        <Stack.Screen name="Barcode" component={BarcodeScreen} options={{ title: 'Barcode' }} />
        <Stack.Screen name="Capture" component={CaptureScreen} options={{ title: 'Capture' }} />
        <Stack.Screen name="Library" component={LibraryScreen} options={{ title: 'Library' }} />
        <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'History' }} />
        <Stack.Screen name="Result" component={ResultScreen} options={{ title: 'Result' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
