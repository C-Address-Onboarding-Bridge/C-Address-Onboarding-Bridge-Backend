FROM rust:1.83-slim
WORKDIR /app
COPY . .
ENV BRIDGE_BASE_URL=http://mock:3099
RUN cargo build --example bridge --release
CMD ["./target/release/examples/bridge"]
