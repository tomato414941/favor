import { createRoot } from 'react-dom/client';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/600.css';
import '@fontsource/newsreader/500-italic.css';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
