//! SQLite 中的 API Key 使用当前 Windows 账号的 DPAPI 保护。
//! 前端收到的仍是原始配置，因此应用导出的配置备份包含可跨电脑迁移的明文 Key。
use serde_json::Value;
#[cfg(windows)]
use windows_sys::Win32::Foundation::LocalFree;
#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use super::{Result, StorageError};

const ENVELOPE_KEY: &str = "__qiqi_windows_dpapi_v1";

fn protected_data_error() -> StorageError {
    StorageError::new(
        "secret_unavailable",
        "无法解密本地 API Key，数据未被覆盖。请使用原 Windows 账号和电脑打开，或从原电脑的应用内导出配置后迁移。",
    )
}

#[cfg(windows)]
fn crypt_bytes(bytes: &[u8], protect: bool) -> Result<Vec<u8>> {
    let mut input = bytes.to_vec();
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(input.len()).map_err(|_| protected_data_error())?,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // 输入缓冲区在调用结束前保持有效；输出由 DPAPI 分配，并在复制后交还 LocalFree。
    // 不使用 LOCAL_MACHINE 标志，密文只对当前 Windows 账号开放。
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(if protect {
            StorageError::new(
                "secret_unavailable",
                "Windows 无法保护 API Key，本次设置未保存，请检查当前 Windows 账号后重试。",
            )
        } else {
            protected_data_error()
        });
    }
    if output.pbData.is_null() {
        return Err(protected_data_error());
    }
    // 成功返回的指针和长度均由 Windows 提供；释放前不保留任何借用。
    let result = unsafe {
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        result
    };
    Ok(result)
}

fn decode_secret(value: &Value) -> Result<String> {
    let Some(object) = value.as_object() else {
        return Err(protected_data_error());
    };
    let Some(hex) = object.get(ENVELOPE_KEY).and_then(Value::as_str) else {
        return Err(protected_data_error());
    };
    if object.len() != 1 || hex.is_empty() || hex.len() % 2 != 0 {
        return Err(protected_data_error());
    }
    let bytes = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|_| protected_data_error())?;
            u8::from_str_radix(pair, 16).map_err(|_| protected_data_error())
        })
        .collect::<Result<Vec<_>>>()?;
    #[cfg(windows)]
    {
        String::from_utf8(crypt_bytes(&bytes, false)?).map_err(|_| protected_data_error())
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err(protected_data_error())
    }
}

fn transform(value: &mut Value, protect: bool) -> Result<bool> {
    let mut changed = false;
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "apiKey" && child.is_object() {
                    let plaintext = decode_secret(child)?;
                    if !protect {
                        *child = Value::String(plaintext);
                        changed = true;
                    }
                } else if key == "apiKey" && protect {
                    #[cfg(windows)]
                    if let Some(plaintext) = child.as_str().filter(|text| !text.is_empty()) {
                        let bytes = crypt_bytes(plaintext.as_bytes(), true)?;
                        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                        *child = serde_json::json!({ ENVELOPE_KEY: hex });
                        changed = true;
                    }
                } else {
                    changed |= transform(child, protect)?;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                changed |= transform(item, protect)?;
            }
        }
        _ => {}
    }
    Ok(changed)
}

/// 保护非空 apiKey 字段；其他 kv 文本和 JSON 保持原样。
pub(super) fn protect_json(raw: &str) -> Result<String> {
    transform_json(raw, true)
}

/// 还原受保护字段；无法解密时拒绝返回部分默认配置。
pub(super) fn unprotect_json(raw: &str) -> Result<String> {
    transform_json(raw, false)
}

fn transform_json(raw: &str, protect: bool) -> Result<String> {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return Ok(raw.to_owned());
    };
    if !transform(&mut value, protect)? {
        return Ok(raw.to_owned());
    }
    serde_json::to_string(&value).map_err(|_| {
        StorageError::new(
            "secret_unavailable",
            "本地 API 配置编码失败，数据未被覆盖。",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_unrelated_values_and_empty_keys_unchanged() {
        for raw in ["普通设置", "42", r#"{ "apiKey": "", "text": "保留原文" }"#] {
            assert_eq!(protect_json(raw).unwrap(), raw);
            assert_eq!(unprotect_json(raw).unwrap(), raw);
        }
    }

    #[cfg(windows)]
    #[test]
    fn protects_legacy_profiles_and_previous_presets_without_losing_fields() {
        let raw = serde_json::json!({
            "state": {
                "settings": { "apiKey": "本地测试密钥", "profiles": [{ "id": "p", "apiKey": "profile-test-key" }] },
                "previousPresetConfig": { "profiles": [{ "apiKey": "preset-test-key" }] },
                "prompt": "保留提示词"
            },
            "version": 1
        });
        let encrypted = protect_json(&raw.to_string()).unwrap();
        assert!(!encrypted.contains("本地测试密钥"));
        assert!(!encrypted.contains("profile-test-key"));
        assert!(!encrypted.contains("preset-test-key"));
        assert_eq!(protect_json(&encrypted).unwrap(), encrypted);
        let decoded: Value = serde_json::from_str(&unprotect_json(&encrypted).unwrap()).unwrap();
        assert_eq!(decoded, raw);
    }

    #[test]
    fn rejects_corrupted_or_unknown_secret_objects() {
        for raw in [
            r#"{"apiKey":{"__qiqi_windows_dpapi_v1":"x"}}"#,
            r#"{"apiKey":{"__qiqi_windows_dpapi_v1":"001122"}}"#,
            r#"{"apiKey":{"__qiqi_windows_dpapi_v2":"001122"}}"#,
        ] {
            assert_eq!(unprotect_json(raw).unwrap_err().code, "secret_unavailable");
            assert_eq!(protect_json(raw).unwrap_err().code, "secret_unavailable");
        }
    }
}
