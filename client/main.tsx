import { createRoot } from 'react-dom/client';
import '@fontsource/newsreader/latin-400.css';
import '@fontsource/newsreader/latin-400-italic.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/600.css';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
