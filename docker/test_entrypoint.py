import importlib.util
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("entrypoint", Path(__file__).with_name("entrypoint.py"))
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)


class InitializationTests(unittest.TestCase):
    def test_missing_credentials_does_not_create_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            target = Path(directory) / "config.toml"
            with self.assertRaisesRegex(ValueError, "DENOVA_ADMIN"):
                entrypoint.initialize_config(target)
            self.assertFalse(target.exists())

    def test_existing_configuration_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DENOVA_ADMIN_PASSWORD": "replacement"}):
            target = Path(directory) / "config.toml"
            content = 'allow_lan_access = true\nremote_access_username = "saved"\nremote_access_password_hash = "saved-hash"\n'
            target.write_text(content)
            entrypoint.initialize_config(target)
            self.assertEqual(target.read_text(), content)

    def test_inaccessible_existing_configuration_is_rejected_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.toml"
            content = 'allow_lan_access = false\n'
            target.write_text(content)
            with self.assertRaisesRegex(ValueError, "allow_lan_access"):
                entrypoint.initialize_config(target)
            self.assertEqual(target.read_text(), content)

    def test_first_start_hashes_password_and_escapes_toml(self):
        credentials = {"DENOVA_ADMIN_USERNAME": 'owner"name😀', "DENOVA_ADMIN_PASSWORD": 'secret"password'}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, credentials), patch.object(entrypoint, "password_hash", return_value="$2b$hash") as hash_password:
            target = Path(directory) / "config.toml"
            entrypoint.initialize_config(target)
            settings = tomllib.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(settings, {"allow_lan_access": True, "remote_access_username": 'owner"name😀', "remote_access_password_hash": "$2b$hash"})
            hash_password.assert_called_once_with('secret"password')
            self.assertNotIn(credentials["DENOVA_ADMIN_PASSWORD"], target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
