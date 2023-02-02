import './App.css'
import { Canvas } from '@react-three/fiber'
import { MapTerrain } from './components/MapTerrain'

function App() {
  return (
    <Canvas
      className='scene'
      onCreated={(state) => state.gl.setClearColor('#353535')}
    >
      <MapTerrain
        location={{ lat: 45.916216, lon: 6.860973 }}
        source={{ api: 'mapbox', token: '123' }}
      />
    </Canvas>
  )
}

export default App
