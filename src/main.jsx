import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Workbench from './components/Workbench.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {window.location.hash === '#workbench' ? <Workbench /> : <App />}
  </React.StrictMode>
)
