import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig(({ mode }) => ({
  plugins: [vue(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
}))
