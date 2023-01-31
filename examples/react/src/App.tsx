import './App.css'
import { Canvas } from '@react-three/fiber'
import { MapTerrain } from './components/MapTerrain'

function App() {
  return (
    <Canvas
      style={{ width: '100vw !important', height: '100vh !important' }}
      onCreated={(state) => state.gl.setClearColor('#353535')}
    >
      <MapTerrain
        location={[27.986065, 86.922623]}
        source={{ api: 'mapbox', token: '123' }}
      />
    </Canvas>
  )
}

export default App
