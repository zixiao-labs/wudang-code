declare module '*.css'

declare module '*.woff2?url' {
  const url: string
  export default url
}

declare module '*.svg?url' {
  const url: string
  export default url
}
