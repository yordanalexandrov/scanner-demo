import { registerRootComponent } from 'expo';

import App from './src/App';

// registerRootComponent wraps AppRegistry.registerComponent('main', () => App) and sets the
// environment up identically whether the bundle is loaded by the dev client or by a release build.
registerRootComponent(App);
