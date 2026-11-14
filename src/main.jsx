import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Workbench from './components/Workbench.jsx'
// Fonts are bundled (no network needed): IBM Plex Sans for the interface,
// IBM Plex Mono for formulas, SQL and ids, Fraunces for the logo, and Wine
// Tahoma (or DejaVu Sans) for diagram text (src/diagram/diagramFont.js).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/fraunces/300.css'
import '@fontsource/fraunces/600.css'
import '@fontsource/fraunces/300-italic.css'
import './assets/fonts/diagram-fonts.css'
import './index.css'
import { diagramFontsReady } from './diagram/diagramFont.js'

// Shape sizes are measured from text, so the diagram fonts load first.
diagramFontsReady().then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {window.location.hash === '#workbench' ? <Workbench /> : <App />}
  </React.StrictMode>
))
