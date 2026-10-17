const { resolve } = require('node:path')

const HtmlWebpackPlugin = require('html-webpack-plugin')
const { ProgressPlugin } = require('webpack')

/** @type {(env: unknown, argv: { mode?: string }) => import('webpack').Configuration} */
module.exports = (_env, argv) => ({
  mode: argv.mode ?? 'development',

  entry: './src/index.ts',
  output: {
    filename: 'bundle.[contenthash].js',
    path: resolve(__dirname, 'dist'),
    clean: true
  },

  devtool: 'source-map',

  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      // `three-map-terrain` is linked from the repo root: make it use this
      // example's copy of three instead of bundling a second one
      three$: resolve(__dirname, 'node_modules/three')
    }
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader']
      }
    ]
  },

  plugins: [
    new ProgressPlugin(),
    new HtmlWebpackPlugin({ template: resolve(__dirname, 'src/index.html') })
  ],

  performance: {
    // three.js alone is above webpack's default 244 KiB budget
    hints: false
  }
})
