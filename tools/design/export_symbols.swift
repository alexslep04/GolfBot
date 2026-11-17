import SwiftUI
import AppKit

// Usage: swift export.swift outDir name1 name2 ...
let args = CommandLine.arguments
let outDir = URL(fileURLWithPath: args[1])
let names = Array(args.dropFirst(2))

@MainActor func run() {
    for name in names {
        guard NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil else {
            print("MISSING \(name)"); continue
        }
        let view = Image(systemName: name)
            .font(.system(size: 100, weight: .bold, design: .rounded))
            .foregroundStyle(.black)
            .padding(10)
        let renderer = ImageRenderer(content: view)
        let url = outDir.appendingPathComponent(name + ".pdf")
        renderer.render { size, draw in
            var box = CGRect(origin: .zero, size: size)
            guard let ctx = CGContext(url as CFURL, mediaBox: &box, nil) else { return }
            ctx.beginPDFPage(nil)
            draw(ctx)
            ctx.endPDFPage()
            ctx.closePDF()
            print("OK \(name) \(Int(size.width))x\(Int(size.height))")
        }
    }
}
DispatchQueue.main.async { Task { @MainActor in run(); exit(0) } }
RunLoop.main.run()
