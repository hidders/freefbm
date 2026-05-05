import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', gap: 16, fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
          background: 'var(--bg-canvas)', color: 'var(--ink)',
        }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', maxWidth: 480, textAlign: 'center' }}>
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '8px 20px', fontSize: 13, borderRadius: 4, cursor: 'pointer',
              background: 'var(--accent)', color: '#fff', border: 'none',
            }}
          >
            Try to recover
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
