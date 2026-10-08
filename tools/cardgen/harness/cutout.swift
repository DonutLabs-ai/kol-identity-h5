// Subject cut-out for the 2.5D card portrait — macOS Vision "subject lifting" (VNGenerateForegroundInstanceMaskRequest).
// Output: out.cut.png — an RGBA PNG the size of the input with only the foreground subject(s), everything else transparent;
//         out.plate.jpg (optional 3rd arg) — the "clean plate": the same art with the subject area filled by a heavy blur of
//         itself, so when the cut-out pans over it no second rim of the figure shows (only a few px near the silhouette are ever seen).
//
//   swiftc -O cutout.swift -o bin/cutout                   (server.mjs builds it on first use)
//   bin/cutout in.png out.cut.png [out.plate.jpg]          exit 0 ok · 2 no foreground found · 1 error
//
// Mac-only: this is the mock backend's path. A Linux backend does the same step with rembg (isnet-general-use)
// or BiRefNet — see BACKEND.md §4 step 5.
import Foundation
import Vision
import CoreImage
import ImageIO

let args = CommandLine.arguments
guard args.count == 3 || args.count == 4 else { FileHandle.standardError.write("usage: cutout in.png out.cut.png [out.plate.jpg]\n".data(using: .utf8)!); exit(1) }
let inURL = URL(fileURLWithPath: args[1]), outURL = URL(fileURLWithPath: args[2]), plateURL = args.count == 4 ? URL(fileURLWithPath: args[3]) : nil
guard let src = CIImage(contentsOf: inURL) else { FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!); exit(1) }

let handler = VNImageRequestHandler(ciImage: src, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
do { try handler.perform([request]) } catch { FileHandle.standardError.write("vision: \(error)\n".data(using: .utf8)!); exit(1) }
guard let result = request.results?.first, !result.allInstances.isEmpty else { FileHandle.standardError.write("no foreground\n".data(using: .utf8)!); exit(2) }

do {
  // croppedToInstancesExtent:false keeps the input's geometry, so the cut-out overlays the art 1:1
  let buf = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
  let out = CIImage(cvPixelBuffer: buf)
  let ctx = CIContext()
  guard let png = ctx.pngRepresentation(of: out, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [:]) else { exit(1) }
  try png.write(to: outURL)
  // coverage (share of opaque pixels) on stderr — the server logs it and rejects empty/near-full masks
  let mask = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  let w = CVPixelBufferGetWidth(mask), h = CVPixelBufferGetHeight(mask), stride = CVPixelBufferGetBytesPerRow(mask)
  let base = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: Float32.self)
  var sum: Double = 0
  for y in 0..<h { let row = base.advanced(by: y * stride / 4); for x in 0..<w { sum += Double(row[x]) } }
  CVPixelBufferUnlockBaseAddress(mask, .readOnly)
  if let plateURL = plateURL {
    // subject region (grown by 10 px past the soft edge) ← a 28 px blur of the art; everything else stays the art
    let region = CIImage(cvPixelBuffer: mask).applyingFilter("CIMorphologyMaximum", parameters: ["inputRadius": 10])
    let blurred = src.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: ["inputRadius": 28]).cropped(to: src.extent)
    let plate = blurred.applyingFilter("CIBlendWithMask", parameters: ["inputBackgroundImage": src, "inputMaskImage": region])
    guard let jpg = ctx.jpegRepresentation(of: plate, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9]) else { exit(1) }
    try jpg.write(to: plateURL)
  }
  print(String(format: "coverage %.3f", sum / Double(w * h)))
} catch { FileHandle.standardError.write("mask: \(error)\n".data(using: .utf8)!); exit(1) }
