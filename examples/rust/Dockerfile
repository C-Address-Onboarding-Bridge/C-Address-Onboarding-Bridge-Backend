# Cargo.lock pins crates (idna_adapter 1.2.x) that need a newer toolchain than 1.83
FROM rust:1-slim
WORKDIR /app
COPY . .
ENV BRIDGE_BASE_URL=http://mock:3099
RUN cargo build --example bridge --release
CMD ["./target/release/examples/bridge"]
