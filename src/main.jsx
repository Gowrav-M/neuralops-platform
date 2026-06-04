import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const productionAuthRedirectUrl = import.meta.env.VITE_AUTH_REDIRECT_URL || 'https://neuralops-platform.vercel.app';
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const hasSupabaseAuthHash = window.location.hash.includes('access_token=') || window.location.hash.includes('refresh_token=');

if (isLocalhost && hasSupabaseAuthHash) {
  window.location.replace(`${productionAuthRedirectUrl}${window.location.hash}`);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
