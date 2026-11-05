# syntax=docker/dockerfile:1.7
#
# Lumra image processor (ADR-002): Node 22 + sharp built from source against a libvips that has
# libheif + libde265, so iPhone HEIC (HEVC) decodes. sharp's prebuilt binaries ship libheif
# without an HEVC decoder, which is why we don't use them here.
#
# Build context: apps/image-processor, after `pnpm --filter @lumra/image-processor build`
# (produces dist/server.mjs + dist/package.json). Cloudflare Containers require linux/amd64.
#
#   docker build --platform linux/amd64 -t lumra-image-processor apps/image-processor
#
# Behind a TLS-intercepting proxy, pass its CA as an optional BuildKit secret:
#   docker build --secret id=ca,src=/path/to/ca.pem ...
#
# No apt-get: the build stage is a buildpack-deps based image that already carry the -dev
# packages libvips needs (glib, expat, libjpeg, libpng, libwebp, lcms2, libexif, zlib). The
# runtime stage copies exactly the shared objects sharp needs (resolved with ldd).

# Node 22 LTS on Debian trixie. Pin by digest (node:22-trixie@sha256:...) for reproducible deploys.
ARG NODE_VERSION=22

# ---------------------------------------------------------------- 1. native libraries + sharp
FROM --platform=linux/amd64 node:${NODE_VERSION}-trixie AS build

ARG LIBDE265_VERSION=1.0.16
ARG LIBDE265_SHA256=b92beb6b53c346db9a8fae968d686ab706240099cdd5aff87777362d668b0de7
ARG LIBHEIF_VERSION=1.22.0
ARG LIBHEIF_SHA256=8bd20cfa3201997b8f63266cddfabea2e1481467d7f992e6a2595e0bec691fc2
ARG VIPS_VERSION=8.18.7
ARG VIPS_SHA256=5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94
# Build tools (meson, ninja, cmake) come from PyPI via a pinned pip wheel; the image has python3
# but no pip, and this avoids depending on apt mirrors.
ARG PIP_WHEEL=https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl
ARG PIP_SHA256=9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd

ENV PREFIX=/opt/vips
ENV PKG_CONFIG_PATH=/opt/vips/lib/pkgconfig

WORKDIR /src
RUN --mount=type=secret,id=ca,required=false \
    set -eux; \
    if [ -f /run/secrets/ca ]; then export SSL_CERT_FILE=/run/secrets/ca PIP_CERT=/run/secrets/ca; fi; \
    fetch() { curl -fsSL --retry 3 -o "$2" "$1"; echo "$3  $2" | sha256sum -c -; }; \
    fetch "${PIP_WHEEL}" /tmp/pip-25.3-py3-none-any.whl "${PIP_SHA256}"; \
    python3 /tmp/pip-25.3-py3-none-any.whl/pip install --no-cache-dir --root-user-action=ignore \
      --break-system-packages meson==1.9.1 ninja==1.13.0 cmake==4.1.2; \
    fetch "https://github.com/strukturag/libde265/releases/download/v${LIBDE265_VERSION}/libde265-${LIBDE265_VERSION}.tar.gz" de265.tar.gz "${LIBDE265_SHA256}"; \
    fetch "https://github.com/strukturag/libheif/releases/download/v${LIBHEIF_VERSION}/libheif-${LIBHEIF_VERSION}.tar.gz" heif.tar.gz "${LIBHEIF_SHA256}"; \
    fetch "https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz" vips.tar.xz "${VIPS_SHA256}"; \
    mkdir de265 heif vips; \
    tar xzf de265.tar.gz -C de265 --strip-components=1; \
    tar xzf heif.tar.gz -C heif --strip-components=1; \
    tar xJf vips.tar.xz -C vips --strip-components=1

# libde265: HEVC decoder only (no SDL viewer, no encoder).
RUN set -eux; \
    cmake -S de265 -B de265/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=${PREFIX} -DCMAKE_INSTALL_LIBDIR=lib \
      -DENABLE_SDL=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF; \
    cmake --build de265/build; cmake --install de265/build

# libheif: HEVC decode via libde265 only. Every other codec is off to keep the attack surface
# (and the runtime dependency list) minimal.
RUN set -eux; \
    cmake -S heif -B heif/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=${PREFIX} -DCMAKE_INSTALL_LIBDIR=lib \
      -DWITH_LIBDE265=ON -DWITH_X265=OFF -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF \
      -DWITH_VVDEC=OFF -DWITH_VVENC=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF \
      -DWITH_OpenH264_ENCODER=OFF -DWITH_DAV1D=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
      -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
      -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_FFMPEG_DECODER=OFF \
      -DWITH_OPENJPH_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=OFF \
      -DWITH_LIBSHARPYUV=OFF -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DENABLE_PLUGIN_LOADING=OFF \
      -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF -DWITH_FUZZERS=OFF; \
    cmake --build heif/build; cmake --install heif/build

# libvips: only the loaders/savers Lumra accepts (JPEG, PNG, WebP, HEIF) plus EXIF and LCMS for
# orientation and ICC → sRGB. Everything else (SVG, PDF, TIFF, GIF, magick, …) is compiled out.
RUN set -eux; \
    cd vips; \
    meson setup build --prefix=${PREFIX} --libdir=lib --buildtype=release \
      -Ddeprecated=false -Dexamples=false -Dcplusplus=true -Ddocs=false -Dcpp-docs=false \
      -Dmodules=disabled -Dintrospection=disabled -Dvapi=false \
      -Djpeg=enabled -Dpng=enabled -Dwebp=enabled -Dheif=enabled -Dexif=enabled -Dlcms=enabled \
      -Dzlib=enabled -Dspng=disabled -Dcfitsio=disabled -Dcgif=disabled -Dfftw=disabled \
      -Dfontconfig=disabled -Darchive=disabled -Dimagequant=disabled -Duhdr=disabled \
      -Djpeg-xl=disabled -Dmagick=disabled -Dmatio=disabled -Dnifti=disabled -Dopenexr=disabled \
      -Dopenjpeg=disabled -Dopenslide=disabled -Dhighway=disabled -Dorc=disabled \
      -Dpangocairo=disabled -Dpdfium=disabled -Dpoppler=disabled -Dquantizr=disabled \
      -Draw=disabled -Drsvg=disabled -Dtiff=disabled -Dnsgif=false -Dppm=false -Danalyze=false \
      -Dradiance=false; \
    meson compile -C build; meson install -C build

# sharp from source against /opt/vips (pkg-config), without the prebuilt @img/* binaries.
ENV LD_LIBRARY_PATH=/opt/vips/lib \
    npm_config_update_notifier=false
WORKDIR /app
COPY dist/package.json ./
RUN --mount=type=secret,id=ca,required=false \
    set -eux; \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm install --omit=optional --omit=dev --no-audit --no-fund; \
    npm install --no-save --no-audit --no-fund node-addon-api@8 node-gyp@12; \
    (cd node_modules/sharp && npm run build); \
    rm -rf node_modules/node-addon-api node_modules/node-gyp node_modules/sharp/src/build/Release/obj.target; \
    node -e "const s=require('sharp'); if (!s.versions.vips.startsWith('8.18')) process.exit(1); console.log('sharp', s.versions)"
COPY dist/server.mjs dist/server.mjs.map ./
# Collect the non-glibc shared objects sharp + libvips link against for the slim runtime.
RUN set -eux; \
    mkdir -p /runtime-libs; \
    find /app/node_modules/sharp -name '*.node' -exec ldd {} \; > /tmp/ldd.txt; \
    ldd /opt/vips/lib/libvips-cpp.so.* >> /tmp/ldd.txt; \
    awk '/=> \// { print $3 }' /tmp/ldd.txt | sort -u \
      | grep -v -E '/(libc|libm|libdl|libpthread|librt|ld-linux[^/]*|libstdc\+\+|libgcc_s)\.so' \
      | grep -v '^/opt/vips/' \
      | xargs -r cp -L -t /runtime-libs

# ---------------------------------------------------------------- 2. runtime
FROM --platform=linux/amd64 node:${NODE_VERSION}-trixie-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    LD_LIBRARY_PATH=/opt/vips/lib:/opt/runtime-libs \
    # Per-request libvips threads are capped in code; this bounds glib's pool as well.
    VIPS_CONCURRENCY=2
COPY --from=build /opt/vips/lib /opt/vips/lib
COPY --from=build /runtime-libs /opt/runtime-libs
COPY --from=build /app /app
WORKDIR /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "server.mjs"]
