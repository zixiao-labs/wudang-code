pub mod auth {
    tonic::include_proto!("wudang.auth.v1");
}

pub mod changes {
    tonic::include_proto!("wudang.changes.v1");
}

pub mod collab {
    tonic::include_proto!("wudang.collab.v1");
}

pub mod repository {
    tonic::include_proto!("wudang.repository.v1");
}

pub mod sync {
    tonic::include_proto!("wudang.sync.v1");
}

pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("wudang_descriptor");
