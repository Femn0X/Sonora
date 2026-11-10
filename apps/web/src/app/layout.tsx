export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0e0e0e", color: "#eee", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
