use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let proto_root = manifest_dir.join("../../../proto");
    let files = [
        "auth.proto",
        "changes.proto",
        "collab.proto",
        "repository.proto",
        "sync.proto",
    ]
    .map(|file| proto_root.join(file));

    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    // SAFETY: build scripts execute in their own process before any threads are started.
    unsafe {
        env::set_var("PROTOC", protoc);
    }

    let descriptor_path = PathBuf::from(env::var("OUT_DIR")?).join("wudang_descriptor.bin");
    tonic_prost_build::configure()
        .file_descriptor_set_path(descriptor_path)
        .boxed(".wudang.collab.v1.DocumentReady.catch_up.snapshot")
        .boxed(".wudang.collab.v1.ServerCollabMessage.payload.ready")
        .compile_protos(&files, &[proto_root])?;

    Ok(())
}
