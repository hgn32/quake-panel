import './styles.css';
import { App } from './app.js';

const app = new App();
void app.start().catch((error) => {
  console.error('起動に失敗しました', error);
  const notice = document.getElementById('map-notice');
  if (notice) {
    notice.textContent = `起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
    notice.hidden = false;
  }
});

// キオスクでは基本的に発火しないが、開発時のホットリロードで多重起動しないように
window.addEventListener('beforeunload', () => app.dispose());
