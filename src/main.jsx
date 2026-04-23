import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import WalletContextProvider from './stake/WalletContextProvider.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WalletContextProvider>
      <App />
    </WalletContextProvider>
  </React.StrictMode>,
);
