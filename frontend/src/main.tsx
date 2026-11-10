import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { GenreCatalogProvider } from './genres'
import { LivingBackdrop } from './components/LivingBackdrop'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GenreCatalogProvider>
      <div className="living-root">
        <LivingBackdrop />
        <App />
      </div>
    </GenreCatalogProvider>
  </React.StrictMode>,
)
