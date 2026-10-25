import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import ibmPlexMono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url'
import ibmPlexMono500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2?url'
import ibmPlexMono600 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url'
import '../../globals.css'

const fontStyles = document.createElement('style')
fontStyles.textContent = `
  @font-face {
    font-family: "IBM Plex Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 400;
    src: url("${ibmPlexMono400}") format("woff2");
  }

  @font-face {
    font-family: "IBM Plex Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 500;
    src: url("${ibmPlexMono500}") format("woff2");
  }

  @font-face {
    font-family: "IBM Plex Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 600;
    src: url("${ibmPlexMono600}") format("woff2");
  }
`
document.head.append(fontStyles)

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
