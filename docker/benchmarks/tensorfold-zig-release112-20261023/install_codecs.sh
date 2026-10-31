#!/usr/bin/env bash
set -euo pipefail
runtime=/opt/ieti-tf112
codec_sha=d3f9d7ddd998758e1850b37153a7904bdcdeb8cf54a782c772780b0bc50dd553
codec_dir="$runtime/codecs"
if [ "$(cat "$codec_dir/ready" 2>/dev/null || true)" != "$codec_sha" ];then
 mkdir -p "$codec_dir"
 curl -fsSL --retry 3 -o "$codec_dir/jpeg.deb" https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.4.1/libjpeg-turbo-official_3.1.4.1_arm64.deb
 echo "$codec_sha  $codec_dir/jpeg.deb" | sha256sum -c -
 dpkg-deb -x "$codec_dir/jpeg.deb" "$codec_dir"
 cp -a "$codec_dir"/opt/libjpeg-turbo/lib64/libturbojpeg.so* "$runtime/tensorfold-1.1.2-linux-aarch64/lib/"
 printf '%s\n' "$codec_sha" > "$codec_dir/ready"
fi
sha256sum "$runtime/tensorfold-1.1.2-linux-aarch64/lib/libturbojpeg.so.0.4.0"
