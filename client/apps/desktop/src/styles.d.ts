declare module '*.css'

declare module 'virtual:nasti-tanstack-router' {
  export const routerMode: 'file' | 'manual'
}

declare module '*.woff2?url' {
  const url: string
  export default url
}

declare module '*.svg?url' {
  const url: string
  export default url
}
