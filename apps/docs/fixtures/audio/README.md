`synthetic-tone.m4a` は録音と M4A 判定のテスト用に作成した 13.35 秒の 440 Hz 合成音です。人物の声や録音データを含みません。

生成コマンド:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=22050:duration=13.35' -c:a aac -b:a 32k -movflags +faststart synthetic-tone.m4a
```

日本語文字起こしの任意 E2E は、この合成音ではなく `NIHO_SPEECH_TEST_FIXTURE` でローカルの音声を指定します。
