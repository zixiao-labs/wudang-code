import { useState } from 'react'

export function App() {
  const [count, setCount] = useState(0)

  return (
    <main>
      <h1>Nasti + React</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      <p>
        Edit <code>src/App.tsx</code> and save to test HMR.
      </p>
    </main>
  )
}
