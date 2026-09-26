#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *stage, int error) {
    char detail[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error, detail, sizeof(detail));
    fprintf(stderr, "%s: %s\n", stage, detail);
}

int main(void) {
    /* The parent writes the RTMPS URL to fd 3. It never appears in argv or logs. */
    FILE *secret = fdopen(3, "r");
    if (!secret) {
        perror("stream URL pipe");
        return 2;
    }
    char url[4096];
    if (!fgets(url, sizeof(url), secret)) {
        fclose(secret);
        fprintf(stderr, "Stream URL pipe is empty.\n");
        return 2;
    }
    fclose(secret);
    url[strcspn(url, "\r\n")] = 0;
    if (strncmp(url, "rtmps://", 8) != 0) {
        fprintf(stderr, "Refusing a non-TLS stream URL.\n");
        memset(url, 0, sizeof(url));
        return 2;
    }

    AVFormatContext *input = NULL;
    AVFormatContext *output = NULL;
    int result = avformat_open_input(&input, "pipe:0", NULL, NULL);
    if (result < 0) { fail("Open encoder pipe", result); goto failed; }
    result = avformat_find_stream_info(input, NULL);
    if (result < 0) { fail("Read encoder stream", result); goto failed; }
    result = avformat_alloc_output_context2(&output, NULL, "flv", url);
    if (result < 0 || !output) { fail("Open RTMPS output", result); goto failed; }

    for (unsigned i = 0; i < input->nb_streams; i++) {
        AVStream *stream = avformat_new_stream(output, NULL);
        if (!stream) { fprintf(stderr, "Unable to allocate output stream.\n"); goto failed; }
        result = avcodec_parameters_copy(stream->codecpar, input->streams[i]->codecpar);
        if (result < 0) { fail("Copy stream metadata", result); goto failed; }
        stream->codecpar->codec_tag = 0;
        stream->time_base = input->streams[i]->time_base;
    }
    if (!(output->oformat->flags & AVFMT_NOFILE)) {
        result = avio_open2(&output->pb, url, AVIO_FLAG_WRITE, NULL, NULL);
        memset(url, 0, sizeof(url));
        if (result < 0) { fail("Connect to Twitch", result); goto failed; }
    }
    result = avformat_write_header(output, NULL);
    if (result < 0) { fail("Write RTMP header", result); goto failed; }
    AVPacket *packet = av_packet_alloc();
    if (!packet) { fprintf(stderr, "Unable to allocate packet.\n"); goto failed; }
    while ((result = av_read_frame(input, packet)) >= 0) {
        AVStream *src = input->streams[packet->stream_index];
        AVStream *dst = output->streams[packet->stream_index];
        av_packet_rescale_ts(packet, src->time_base, dst->time_base);
        packet->pos = -1;
        result = av_interleaved_write_frame(output, packet);
        av_packet_unref(packet);
        if (result < 0) { fail("Publish stream", result); break; }
    }
    av_packet_free(&packet);
    av_write_trailer(output);
    if (output && !(output->oformat->flags & AVFMT_NOFILE)) avio_closep(&output->pb);
    avformat_free_context(output);
    avformat_close_input(&input);
    return result == AVERROR_EOF || result >= 0 ? 0 : 1;

failed:
    memset(url, 0, sizeof(url));
    if (output) {
        if (!(output->oformat->flags & AVFMT_NOFILE)) avio_closep(&output->pb);
        avformat_free_context(output);
    }
    if (input) avformat_close_input(&input);
    return 1;
}
